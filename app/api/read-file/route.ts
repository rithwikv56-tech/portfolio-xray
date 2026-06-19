import { GoogleGenerativeAI } from "@google/generative-ai";
import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit, getClientIp } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const maxDuration = 60;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/jpg", "image/webp"];

// Uses Gemini's native vision to read a portfolio statement from a PDF or screenshot.
// Far more reliable than OCR, and works on serverless hosts like Vercel.
export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  const rl = await checkRateLimit(ip);
  if (!rl.ok) return NextResponse.json({ error: rl.message }, { status: 429 });

  if (!process.env.GEMINI_API_KEY) {
    return NextResponse.json({ error: "File reading isn't configured — missing API key." }, { status: 500 });
  }

  let file: File | null = null;
  try {
    const formData = await req.formData();
    file = formData.get("file") as File | null;
  } catch {
    return NextResponse.json({ error: "Upload failed to reach the server. Please try again." }, { status: 400 });
  }

  if (!file) return NextResponse.json({ error: "No file received. Please pick a PDF or screenshot and try again." }, { status: 400 });

  const name = (file.name || "").toLowerCase();
  const isPdf = file.type === "application/pdf" || name.endsWith(".pdf");
  const isImage = IMAGE_TYPES.includes(file.type) || /\.(png|jpe?g|webp)$/i.test(name);

  if (!isPdf && !isImage) {
    return NextResponse.json({ error: "That file type isn't supported. Upload a PDF or an image (PNG/JPG)." }, { status: 400 });
  }
  if (file.size === 0) return NextResponse.json({ error: "That file appears to be empty." }, { status: 400 });
  if (file.size > 15 * 1024 * 1024) return NextResponse.json({ error: "That file is over 15MB. Try a smaller file." }, { status: 400 });

  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    const base64 = bytes.toString("base64");
    const mimeType = isPdf ? "application/pdf" : (file.type || "image/png");

    const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || "gemini-2.5-flash" });

    const prompt = `This file is an investment/mutual-fund account statement or a screenshot of a portfolio (for example from Groww, Zerodha, or a CAS). Extract the holdings as plain text. For each holding, output a line with: fund or stock name, units if shown, NAV/price if shown, and current value if shown. Keep it simple and faithful — do not invent anything. If you cannot find any holdings, reply with exactly: NO_HOLDINGS_FOUND.`;

    const result = await model.generateContent([
      { inlineData: { data: base64, mimeType } },
      { text: prompt },
    ]);

    const text = (result.response.text() || "").trim();

    if (!text || text.includes("NO_HOLDINGS_FOUND") || text.length < 15) {
      return NextResponse.json(
        { error: "Couldn't find holdings in that file. Try a clearer screenshot, or paste the text instead." },
        { status: 422 }
      );
    }

    return NextResponse.json({ text });
  } catch (err) {
    console.error("read-file error:", err);
    const msg = err instanceof Error && /quota|rate|429/i.test(err.message)
      ? "Too many requests right now — wait about a minute and try again."
      : "Couldn't read that file. Please paste the text instead.";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
