import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit, getClientIp } from "@/lib/ratelimit";

export const maxDuration = 60;

const MAX_PAGES = 5;

export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  const rl = await checkRateLimit(ip);
  if (!rl.ok) return NextResponse.json({ error: rl.message }, { status: 429 });

  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    if (!file) return NextResponse.json({ error: "No file received." }, { status: 400 });
    if (file.type !== "application/pdf") return NextResponse.json({ error: "Please upload a PDF." }, { status: 400 });
    if (file.size > 15 * 1024 * 1024) return NextResponse.json({ error: "File too large for OCR (max 15MB)." }, { status: 400 });

    const buffer = Buffer.from(await file.arrayBuffer());

    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const canvasMod = await import("@napi-rs/canvas").catch(() => null);
    if (!canvasMod) {
      return NextResponse.json(
        { error: "OCR isn't available in this environment. Please paste the statement text instead." },
        { status: 501 }
      );
    }
    const { createCanvas } = canvasMod;

    const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
    const pageCount = Math.min(doc.numPages, MAX_PAGES);

    const Tesseract = (await import("tesseract.js")).default;
    const worker = await Tesseract.createWorker("eng");

    let fullText = "";
    try {
      for (let p = 1; p <= pageCount; p++) {
        const page = await doc.getPage(p);
        const viewport = page.getViewport({ scale: 2 });
        const canvas = createCanvas(viewport.width, viewport.height);
        const ctx = canvas.getContext("2d");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await page.render({ canvas: canvas as any, canvasContext: ctx as any, viewport }).promise;
        const png = canvas.toBuffer("image/png");
        const { data } = await worker.recognize(png);
        fullText += data.text + "\n";
      }
    } finally {
      await worker.terminate();
    }

    const text = fullText.trim();
    if (text.length < 20) {
      return NextResponse.json({ error: "OCR couldn't read enough text. Try a clearer scan, or paste the text." }, { status: 422 });
    }
    return NextResponse.json({ text, pagesProcessed: pageCount, totalPages: doc.numPages });
  } catch (err) {
    console.error("OCR error:", err);
    return NextResponse.json({ error: "OCR failed. Please paste the statement text instead." }, { status: 500 });
  }
}
