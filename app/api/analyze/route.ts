import { GoogleGenerativeAI } from "@google/generative-ai";
import { NextRequest } from "next/server";
import { checkRateLimit, getClientIp } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const maxDuration = 60;

// Uses Google Gemini's FREE tier (no credit card). Set GEMINI_API_KEY in .env.local.
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

const SYSTEM_PROMPT = `You are a clear-eyed Indian portfolio analyst. A retail investor has given you their mutual fund / stock statement — often a messy Consolidated Account Statement (CAS) from CAMS/KFintech, a broker holding report (Zerodha, Groww, Upstox), or a fund-house statement. Tell them, in plain language, what they ACTUALLY own.

You understand real Indian statement formats:
- CAMS/KFintech CAS lists folios with "Closing Unit Balance", "NAV", and "Market Value" / "Valuation" columns. Fund names look like "HDFC Mid-Cap Opportunities Fund - Direct Plan - Growth".
- Broker reports list stocks with quantity, avg cost, LTP, and current value.
- "Direct" plans have lower expense ratios than "Regular"; "Growth" reinvests vs "IDCW"/"Dividend" payouts.
- Fund-name keywords map to types: "Liquid"/"Overnight"->Liquid; "Gilt"/"Bond"/"Debt"/"Corporate Bond"->Debt; "Index"/"Nifty"/"Sensex"->Index; "ELSS"/"Tax Saver"->ELSS; "Hybrid"/"Balanced Advantage"/"Aggressive Hybrid"->Hybrid; "Gold"->Gold; "Flexi"/"Multi"/"Large"/"Mid"/"Small"/"Bluechip"/"Focused"->Equity.

Write for an Indian audience: amounts in Rs (lakh/crore where natural) and Indian context (SIP, expense ratio, exit load, LTCG/STCG).

OUTPUT FORMAT — critical. Emit a stream of single-line JSON objects, ONE PER LINE (JSONL), in this exact order. No markdown, no backticks, no prose outside the JSON lines. Each line must be a complete, valid JSON object.

1. First line — meta:
{"kind":"meta","totalValue":"Rs X,XX,XXX or 'Not stated'","confidence":"high|medium|low","verdict":"ONE punchy plain-English sentence a beginner instantly gets — the single most important thing about this portfolio. E.g. 'You're betting big on mid-sized companies — strong growth potential, but expect a bumpy ride.'","riskLevel":"cautious|balanced|aggressive","riskWhy":"Half a sentence on why, in plain words.","persona":"A short, vivid 2-3 word archetype for this investor based on their holdings. E.g. 'The Growth Seeker', 'The Cautious Builder', 'The Balanced Explorer', 'The Aggressive Optimist'. Make it fit THIS portfolio.","personaLine":"One friendly sentence describing this investor type.","riskScore":70,"growthScore":75,"summary":"2-3 sentences: what this portfolio IS. Composed, specific, sharp-advisor tone. No jargon."}

(riskScore and growthScore are 0-100 integers placing this portfolio on a map: riskScore = how much volatility/risk they're taking; growthScore = how much long-term growth potential. A liquid-heavy portfolio is low on both; an all-small-cap one is high on both.)

2. One line per holding, as you identify them:
{"kind":"holding","name":"Fund/stock name as written","type":"Equity|Debt|Hybrid|ELSS|Index|Liquid|Stock|Gold|Other","value":"Rs amount or 'Not stated'","weight":"approx % or 'Unknown'","plainEnglish":"One sentence: what this is and does, no jargon. Be specific to THIS fund, not generic."}

3. One line per allocation slice (grouped by type, summing to ~100):
{"kind":"allocation","label":"Equity","percent":60,"meaning":"One short, plain sentence explaining what holding this much of this type means for them. E.g. 'Most of your money is in stocks — good for long-term growth, but it'll swing with the market.'"}

3b. If there is equity exposure, ONE line breaking the equity portion into market-cap buckets (percentages of the EQUITY portion, summing to ~100). Base it on fund names/types. Omit if no equity.
{"kind":"equityBreakdown","large":40,"mid":45,"small":15}

4. One line per observation (3-5 total):
{"kind":"observation","text":"A sharp, specific, true point about THIS portfolio."}

5. ONE gentle learning nudge (not advice — just something worth understanding):
{"kind":"nudge","text":"A soft, non-pushy pointer to something worth understanding about THIS portfolio, phrased to invite curiosity not alarm. E.g. 'Worth understanding: two of your funds may hold many of the same companies.' Never say buy/sell. Keep it to one sentence."}

6. Final line exactly:
{"kind":"done"}

QUALITY BAR for observations — these are the product. Make them specific and genuinely useful: overlap between funds, over-concentration, idle cash, tax angles, Regular-vs-Direct plan savings. NEVER give generic advice anyone could give without seeing the statement.

HARD RULES:
- NEVER invent holdings or numbers. If unclear, set confidence "low" and say so in the summary. Missing data is fine; fabrication is not.
- This is educational analysis of what they own — NOT a buy/sell recommendation.
- If the text is clearly NOT a financial statement: emit the meta line (confidence "low", summary saying so), then {"kind":"done"} with no holdings.
- Output ONLY the JSON lines, nothing else.`;

export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  const rl = await checkRateLimit(ip);
  if (!rl.ok) {
    return new Response(JSON.stringify({ error: rl.message }), { status: 429, headers: { "Content-Type": "application/json" } });
  }

  if (!process.env.GEMINI_API_KEY) {
    return new Response(JSON.stringify({ error: "The app isn't configured with a Gemini API key yet. Add GEMINI_API_KEY to .env.local." }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }

  let statementText: unknown;
  try { ({ statementText } = await req.json()); } catch {
    return new Response(JSON.stringify({ error: "Invalid request." }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
  if (!statementText || typeof statementText !== "string" || statementText.trim().length < 20) {
    return new Response(JSON.stringify({ error: "Paste your statement — it looks too short to analyse." }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  const trimmed = statementText.slice(0, 60000);

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      try {
        const model = genAI.getGenerativeModel({
          // Defaults to the confirmed free-tier model. To try the newer
          // gemini-3.5-flash (also free), set GEMINI_MODEL in .env.local.
          model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
          systemInstruction: SYSTEM_PROMPT,
        });

        const result = await model.generateContentStream(`Here is my statement:\n\n${trimmed}`);
        for await (const chunk of result.stream) {
          const t = chunk.text();
          if (t) controller.enqueue(encoder.encode(t));
        }
      } catch (err) {
        console.error("Gemini stream error:", err);
        controller.enqueue(encoder.encode('\n{"kind":"error","text":"The analysis failed. If this keeps happening you may have hit the free-tier rate limit — wait a minute and retry."}\n{"kind":"done"}\n'));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" },
  });
}
