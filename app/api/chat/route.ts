import { GoogleGenerativeAI } from "@google/generative-ai";
import { NextRequest } from "next/server";
import { checkRateLimit, getClientIp } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const maxDuration = 60;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

type Holding = { name: string; type: string; value: string; weight: string };
type ChatMsg = { role: "user" | "model"; text: string };

function buildSystemPrompt(ctx: {
  totalValue?: string;
  summary?: string;
  holdings?: Holding[];
  allocation?: { label: string; percent: number }[];
  observations?: string[];
}): string {
  const holdingsList = (ctx.holdings || [])
    .map((h) => `- ${h.name} (${h.type}, ${h.value}, ${h.weight})`)
    .join("\n");
  const allocList = (ctx.allocation || [])
    .map((a) => `- ${a.label}: ${a.percent}%`)
    .join("\n");
  const obsList = (ctx.observations || []).map((o, i) => `${i + 1}. ${o}`).join("\n");

  return `You are a clear, friendly Indian portfolio assistant answering follow-up questions about the user's OWN portfolio, which was just analysed. Answer in plain language an ordinary retail investor understands. Be concise — 2-4 sentences usually, more only if truly needed.

THE USER'S PORTFOLIO:
Total value: ${ctx.totalValue || "not stated"}
Summary: ${ctx.summary || "n/a"}

Holdings:
${holdingsList || "none parsed"}

Allocation:
${allocList || "n/a"}

Already-noted observations:
${obsList || "none"}

RULES:
- Ground every answer in THIS portfolio above. Refer to their actual funds by name when relevant.
- This is educational explanation, NOT a buy/sell recommendation. Never tell them to buy, sell, or switch a specific fund. You can explain trade-offs, terms, and what things mean.
- If asked something you can't know from the data (e.g. their goals, risk appetite, tax bracket), say so briefly and explain what would matter.
- Indian context: SIP, ELSS, expense ratio, LTCG/STCG, exit load, direct vs regular.
- If a question is off-topic (not about their portfolio or investing basics), gently redirect.
- Never invent holdings or numbers not shown above.`;
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  const rl = await checkRateLimit(ip);
  if (!rl.ok) {
    return new Response(JSON.stringify({ error: rl.message }), { status: 429, headers: { "Content-Type": "application/json" } });
  }

  if (!process.env.GEMINI_API_KEY) {
    return new Response(JSON.stringify({ error: "Chat isn't configured — missing Gemini API key." }), { status: 500, headers: { "Content-Type": "application/json" } });
  }

  let body: { context?: Parameters<typeof buildSystemPrompt>[0]; messages?: ChatMsg[] };
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: "Invalid request." }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  const messages = Array.isArray(body.messages) ? body.messages.slice(-12) : [];
  if (messages.length === 0) {
    return new Response(JSON.stringify({ error: "No question provided." }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
  // The last message must be from the user.
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user" || !last.text?.trim()) {
    return new Response(JSON.stringify({ error: "No question provided." }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
  if (last.text.length > 2000) {
    return new Response(JSON.stringify({ error: "That question is too long. Please shorten it." }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      try {
        const model = genAI.getGenerativeModel({
          model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
          systemInstruction: buildSystemPrompt(body.context || {}),
        });

        // All but the last message become history; the last is the new prompt.
        const history = messages.slice(0, -1).map((m) => ({
          role: m.role,
          parts: [{ text: m.text }],
        }));

        const chat = model.startChat({ history });
        const result = await chat.sendMessageStream(last.text);
        for await (const chunk of result.stream) {
          const t = chunk.text();
          if (t) controller.enqueue(encoder.encode(t));
        }
      } catch (err) {
        console.error("Chat stream error:", err);
        controller.enqueue(encoder.encode("\n[Sorry — I couldn't answer that just now. If this keeps happening you may have hit the free-tier rate limit; wait a minute and try again.]"));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" },
  });
}
