import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit, getClientIp } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  const rl = await checkRateLimit(ip);
  if (!rl.ok) return NextResponse.json({ error: rl.message }, { status: 429 });

  let file: File | null = null;
  try {
    const formData = await req.formData();
    file = formData.get("file") as File | null;
  } catch (err) {
    console.error("formData parse failed:", err);
    return NextResponse.json({ error: "Upload failed to reach the server. Please try again." }, { status: 400 });
  }

  if (!file) return NextResponse.json({ error: "No file received. Please pick a PDF and try again." }, { status: 400 });
  // Some browsers send an empty/odd MIME type; accept by extension too.
  const looksPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name || "");
  if (!looksPdf) return NextResponse.json({ error: "That doesn't look like a PDF. Please upload a .pdf file." }, { status: 400 });
  if (file.size === 0) return NextResponse.json({ error: "That file appears to be empty." }, { status: 400 });
  if (file.size > 15 * 1024 * 1024) return NextResponse.json({ error: "That file is over 15MB. Try a smaller PDF." }, { status: 400 });

  let text = "";
  try {
    const buffer = Buffer.from(await file.arrayBuffer());

    // Use pdfjs-dist directly (legacy build works in Node). More reliable under
    // Next's bundler than pdf-parse, and we already depend on it for OCR.
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;

    const pages: string[] = [];
    const maxPages = Math.min(doc.numPages, 25);
    for (let p = 1; p <= maxPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const line = (content.items as any[]).map((it) => (it.str ?? "")).join(" ");
      pages.push(line);
    }
    text = pages.join("\n").replace(/\s+\n/g, "\n").trim();
  } catch (err) {
    console.error("PDF extract error:", err);
    return NextResponse.json(
      { error: "Couldn't read that PDF — it may be corrupted or an unusual format. Try pasting the text instead." },
      { status: 500 }
    );
  }

  // A scanned/image PDF yields almost no extractable text → offer OCR.
  if (text.length < 40) {
    return NextResponse.json(
      { scanned: true, error: "This looks like a scanned PDF (an image, not selectable text). Use the OCR option below, or paste the text." },
      { status: 422 }
    );
  }

  return NextResponse.json({ text });
}
