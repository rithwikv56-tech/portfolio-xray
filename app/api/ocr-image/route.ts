import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit, getClientIp } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const maxDuration = 60;

const ACCEPTED = ["image/png", "image/jpeg", "image/jpg", "image/webp"];

export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  const rl = await checkRateLimit(ip);
  if (!rl.ok) return NextResponse.json({ error: rl.message }, { status: 429 });

  let file: File | null = null;
  try {
    const formData = await req.formData();
    file = formData.get("file") as File | null;
  } catch {
    return NextResponse.json({ error: "Upload failed to reach the server. Please try again." }, { status: 400 });
  }

  if (!file) return NextResponse.json({ error: "No image received. Please pick a screenshot and try again." }, { status: 400 });

  const looksImage = ACCEPTED.includes(file.type) || /\.(png|jpe?g|webp)$/i.test(file.name || "");
  if (!looksImage) return NextResponse.json({ error: "That doesn't look like an image. Upload a PNG or JPG screenshot." }, { status: 400 });
  if (file.size === 0) return NextResponse.json({ error: "That image appears to be empty." }, { status: 400 });
  if (file.size > 15 * 1024 * 1024) return NextResponse.json({ error: "That image is over 15MB. Try a smaller screenshot." }, { status: 400 });

  try {
    const buffer = Buffer.from(await file.arrayBuffer());

    // Upscale small screenshots a little for better OCR, using canvas if available.
    let imageForOcr: Buffer = buffer;
    const canvasMod = await import("@napi-rs/canvas").catch(() => null);
    if (canvasMod) {
      try {
        const { createCanvas, loadImage } = canvasMod;
        const img = await loadImage(buffer);
        // Scale up if the screenshot is small (phone screenshots are often <1080px wide).
        const scale = img.width < 1000 ? 2 : 1.3;
        const canvas = createCanvas(Math.round(img.width * scale), Math.round(img.height * scale));
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        imageForOcr = canvas.toBuffer("image/png");
      } catch {
        imageForOcr = buffer; // fall back to original
      }
    }

    const Tesseract = (await import("tesseract.js")).default;
    const worker = await Tesseract.createWorker("eng");
    let text = "";
    try {
      const { data } = await worker.recognize(imageForOcr);
      text = (data.text || "").trim();
    } finally {
      await worker.terminate();
    }

    if (text.length < 15) {
      return NextResponse.json(
        { error: "Couldn't read enough text from that screenshot. Try a clearer, full-screen capture — or paste the text." },
        { status: 422 }
      );
    }

    return NextResponse.json({ text });
  } catch (err) {
    console.error("Image OCR error:", err);
    return NextResponse.json({ error: "Couldn't read that screenshot. Please paste the text instead." }, { status: 500 });
  }
}
