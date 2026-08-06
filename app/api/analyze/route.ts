import { GoogleGenAI } from "@google/genai";
import { NextRequest } from "next/server";
import { checkRateLimit, getClientIp } from "@/lib/ratelimit";
import { analyseOffline } from "@/lib/offline-analyze";

export const runtime = "nodejs";
export const maxDuration = 60;

// Uses Google Gemini's FREE tier (no credit card). Set GEMINI_API_KEY in .env.local.
const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

// Free-tier quota is counted per model, so falling back to another model buys a
// fresh allowance. GEMINI_MODEL still picks the primary; GEMINI_MODELS replaces
// the whole chain (comma-separated, tried in order).
const MODEL_CHAIN: string[] = (
  process.env.GEMINI_MODELS
    ? process.env.GEMINI_MODELS.split(",")
    : [process.env.GEMINI_MODEL || "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash"]
)
  .map((m) => m.trim())
  .filter(Boolean)
  .filter((m, i, arr) => arr.indexOf(m) === i);

// Set ANALYZE_OFFLINE=1 to bypass Gemini entirely and always serve the
// deterministic analysis — useful when a demo must not depend on a quota.
// With no API key there is nothing to call, so offline is the only option.
const OFFLINE_ONLY = process.env.ANALYZE_OFFLINE === "1" || !process.env.GEMINI_API_KEY;

const SYSTEM_PROMPT = `You are a clear-eyed Indian portfolio analyst. A retail investor has given you their mutual fund / stock statement — often a messy Consolidated Account Statement (CAS) from CAMS/KFintech, a broker holding report (Zerodha, Groww, Upstox), or a fund-house statement. Tell them, in plain language, what they ACTUALLY own.

You understand real Indian statement formats:
- CAMS/KFintech CAS lists folios with "Closing Unit Balance", "NAV", and "Market Value" / "Valuation" columns. Fund names look like "HDFC Mid-Cap Opportunities Fund - Direct Plan - Growth".
- Broker reports list stocks with quantity, avg cost, LTP, and current value.
- "Direct" plans have lower expense ratios than "Regular"; "Growth" reinvests vs "IDCW"/"Dividend" payouts.
- Fund-name keywords map to types: "Liquid"/"Overnight"->Liquid; "Gilt"/"Bond"/"Debt"/"Corporate Bond"->Debt; "Index"/"Nifty"/"Sensex"->Index; "ELSS"/"Tax Saver"->ELSS; "Hybrid"/"Balanced Advantage"/"Aggressive Hybrid"->Hybrid; "Gold"->Gold; "Flexi"/"Multi"/"Large"/"Mid"/"Small"/"Bluechip"/"Focused"->Equity.

Write for an Indian audience: amounts in Rs (lakh/crore where natural) and Indian context (SIP, expense ratio, exit load, LTCG/STCG).

OUTPUT FORMAT — critical. Emit a stream of single-line JSON objects, ONE PER LINE (JSONL), in this exact order. No markdown, no backticks, no prose outside the JSON lines. Each line must be a complete, valid JSON object.

1. First line — meta:
{"kind":"meta","totalValue":"Rs X,XX,XXX or 'Not stated'","confidence":"high|medium|low","verdict":"ONE punchy plain-English sentence a beginner instantly gets — the single most important thing about this portfolio. E.g. 'You're betting big on mid-sized companies — strong growth potential, but expect a bumpy ride.'","riskLevel":"cautious|balanced|aggressive","riskWhy":"Half a sentence on why, in plain words.","persona":"A short, vivid 2-3 word archetype for this investor based on their holdings. E.g. 'The Growth Seeker', 'The Cautious Builder', 'The Balanced Explorer', 'The Aggressive Optimist'. Make it fit THIS portfolio.","personaLine":"One friendly sentence describing this investor type.","riskScore":70,"growthScore":75,"summary":"2-3 sentences: what this portfolio IS. Composed, specific, sharp-advisor tone. No jargon.","reassure":"For an ANXIOUS first-time investor. Three short plain-English points as a single string separated by ' | ': (1) what's genuinely FINE about this portfolio so they can relax, (2) the ONE thing actually worth watching, (3) why they don't need to panic about the rest. Warm, calm, honest. E.g. 'Your money is spread across solid funds — that's good. | The one thing to watch: nearly half sits in one risky bucket. | Otherwise this is a normal, reasonable portfolio — no need to lose sleep.'","worstThing":"The single most important thing in this whole portfolio to pay attention to, in one plain sentence. Just ONE.","crashTest":"Make risk visceral. One honest plain-English sentence: roughly what would happen to THIS portfolio if the market fell sharply (say ~30%), based on its risk level. E.g. 'In a sharp market crash, a portfolio like this could temporarily drop around a quarter to a third of its value — steep, but it has historically recovered over a few years.' Be honest, not scary. For cautious portfolios reassure; for aggressive ones be straight about the swing."}

(reassure and worstThing both speak to the emotional reality of a nervous investor. Be honest, never falsely calming — but lead with what's fine before what's not.)

(riskScore and growthScore are 0-100 integers placing this portfolio on a map: riskScore = how much volatility/risk they're taking; growthScore = how much long-term growth potential. A liquid-heavy portfolio is low on both; an all-small-cap one is high on both.)

2. One line per holding, as you identify them:
{"kind":"holding","name":"Fund/stock name as written","type":"Equity|Debt|Hybrid|ELSS|Index|Liquid|Stock|Gold|Other","value":"Rs amount or 'Not stated'","weight":"approx % or 'Unknown'","plainEnglish":"One sentence: what this is and does, no jargon. Be specific to THIS fund, not generic."}

3. One line per allocation slice (grouped by type, summing to ~100):
{"kind":"allocation","label":"Equity","percent":60,"meaning":"One short, plain sentence explaining what holding this much of this type means for them. E.g. 'Most of your money is in stocks — good for long-term growth, but it'll swing with the market.'"}

3b. If there is equity exposure, ONE line breaking the equity portion into market-cap buckets (percentages of the EQUITY portion, summing to ~100). Base it on fund names/types. Omit if no equity.
{"kind":"equityBreakdown","large":40,"mid":45,"small":15}

3c. If two or more equity funds likely hold many of the SAME underlying stocks (e.g. two large-cap funds, or a large-cap + a Nifty index fund), emit ONE overlap line. Omit entirely if there's no meaningful overlap.
{"kind":"overlap","funds":["Fund A name","Fund B name"],"text":"One plain sentence: these likely own many of the same companies, so you're less diversified than the number of funds suggests."}

3d. If expense ratios or Regular (vs Direct) plans are detectable, emit ONE cost line translating it into rupees. Estimate the annual cost in Rs based on stated/typical expense ratios and the total value. Omit if you truly can't estimate.
{"kind":"cost","text":"Plain sentence translating fees into money. E.g. 'You're paying roughly Rs 12,000 a year in fund fees — and Regular plans cost more than Direct ones for the same fund.'"}

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

// Never echo anything key-shaped back to the browser, whatever the API said.
function redact(s: string): string {
  return s.replace(/\b(AQ\.[A-Za-z0-9_-]+|AIza[A-Za-z0-9_-]+)/g, "[redacted]");
}

// A Gemini 429 carries a google.rpc.QuotaFailure (which limit, and its ceiling)
// and often a RetryInfo. Pull them out by pattern: the JSON body arrives embedded
// in the SDK's message, so it isn't reliably parseable on its own.
function extractQuotaInfo(raw: string): { quotaId?: string; quotaValue?: string; retryDelay?: string } {
  // Gemini nests the real error as a JSON *string* inside the outer JSON, so the
  // fields arrive double-escaped (\"quotaId\"). Unescape before matching, or the
  // patterns silently miss and every 429 falls through to the generic branch.
  const s = raw.replace(/\\"/g, '"').replace(/\\n/g, "\n");
  return {
    quotaId: s.match(/"quotaId"\s*:\s*"([^"]+)"/)?.[1],
    quotaValue: s.match(/"quotaValue"\s*:\s*"?(\d+)"?/)?.[1],
    retryDelay: s.match(/"retryDelay"\s*:\s*"([^"]+)"/)?.[1],
  };
}

// Quota/rate failures are worth retrying on a different model.
function isQuotaError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /429|RESOURCE_EXHAUSTED|quota|rate.?limit/i.test(msg);
}

// So is a model that this key can't reach — Google retires free-tier models and
// closes them to new projects, which is a property of the model, not the request.
function isModelUnavailable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /404|NOT_FOUND|is not found for API version|no longer available|not supported/i.test(msg);
}

function shouldTryNextModel(err: unknown): boolean {
  return isQuotaError(err) || isModelUnavailable(err);
}

// Turn a Gemini failure into something that names the actual cause.
function describeGeminiError(err: unknown, model?: string): string {
  const raw = err instanceof Error ? err.message : String(err);
  const msg = redact(raw);

  if (/429|quota|rate.?limit|RESOURCE_EXHAUSTED/i.test(msg)) {
    const { quotaId, quotaValue, retryDelay } = extractQuotaInfo(msg);

    // quotaValue 0 means the project has no allocation at all — never recovers.
    if (quotaValue === "0") {
      return "This API key's project has no Gemini quota at all, so waiting won't help. Keys made in the Google Cloud console often land on a project with no free-tier access — create a fresh key at aistudio.google.com/apikey and update GEMINI_API_KEY.";
    }
    if (quotaId && /PerDay/i.test(quotaId)) {
      return `Daily Gemini quota used up. This resets at midnight Pacific — waiting a minute won't help. (${quotaId})`;
    }
    if (quotaId && /PerMinute/i.test(quotaId)) {
      return `Per-minute Gemini rate limit hit${retryDelay ? ` — retry in ${retryDelay}` : ""}. Waiting about a minute will fix this.`;
    }
    // Shape we don't recognise: say what we saw rather than guess a cause.
    return `Gemini returned a quota error${retryDelay ? ` (retry in ${retryDelay})` : ""}. If this fired on your first request rather than after repeated use, it's the project's quota, not a burst limit — check aistudio.google.com/apikey. (${msg})`;
  }
  if (/API key not valid|API_KEY_INVALID|400.*api.?key/i.test(msg)) {
    return `Gemini rejected the API key. Check GEMINI_API_KEY is the full key, with no quotes or trailing spaces. (${msg})`;
  }
  if (/401|403|PERMISSION_DENIED|UNAUTHENTICATED/i.test(msg)) {
    return `Gemini refused the request — the key may lack access to the Generative Language API, or the API isn't enabled on that project. (${msg})`;
  }
  if (/404|NOT_FOUND|is not found for API version|not supported/i.test(msg)) {
    return `The model "${model || process.env.GEMINI_MODEL || "gemini-2.5-flash"}" wasn't found for this key. Set GEMINI_MODEL to a model your key can use. (${msg})`;
  }
  return `The analysis failed: ${msg}`;
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  const rl = await checkRateLimit(ip);
  if (!rl.ok) {
    return new Response(JSON.stringify({ error: rl.message }), { status: 429, headers: { "Content-Type": "application/json" } });
  }

  // A missing key is no longer fatal — OFFLINE_ONLY picks up the analysis.

  let statementText: unknown;
  let beginnerMode: unknown;
  try { ({ statementText, beginnerMode } = await req.json()); } catch {
    return new Response(JSON.stringify({ error: "Invalid request." }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
  if (!statementText || typeof statementText !== "string" || statementText.trim().length < 20) {
    return new Response(JSON.stringify({ error: "Paste your statement — it looks too short to analyse." }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  const trimmed = statementText.slice(0, 60000);

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const systemInstruction = beginnerMode === true
        ? SYSTEM_PROMPT + `\n\nIMPORTANT — BEGINNER MODE IS ON: This person is completely new to investing. Write every field as if explaining to a smart friend who has never invested: no financial terms at all without an instant everyday-words explanation, use simple analogies where they help, keep sentences short, and be extra warm and reassuring in tone. Never assume they know what equity, debt, NAV, or allocation mean — always say it in plain everyday words first.`
        : SYSTEM_PROMPT;

      // Free-tier quota is per model, so an exhausted model doesn't mean an
      // exhausted key — try the next one instead of failing the request.
      let sentAnything = false;
      let lastErr: unknown = null;
      let lastModel = MODEL_CHAIN[0];

      const serveOffline = () => {
        for (const line of analyseOffline(trimmed)) {
          controller.enqueue(encoder.encode(JSON.stringify(line) + "\n"));
        }
      };

      try {
        if (OFFLINE_ONLY) {
          serveOffline();
          return;
        }

        for (const model of MODEL_CHAIN) {
          lastModel = model;
          try {
            const result = await genAI.models.generateContentStream({
              model,
              contents: `Here is my statement:\n\n${trimmed}`,
              config: { systemInstruction },
            });

            for await (const chunk of result) {
              const t = chunk.text;
              if (t) { sentAnything = true; controller.enqueue(encoder.encode(t)); }
            }
            lastErr = null;
            break;
          } catch (err) {
            lastErr = err;
            console.error(`Gemini stream error (model ${model}):`, err);
            // Bytes already sent can't be restarted on another model. Otherwise
            // retry only for reasons a different model could actually fix.
            if (sentAnything || !shouldTryNextModel(err)) break;
            console.error(`Model ${model} unusable — trying the next model in the chain.`);
          }
        }

        if (lastErr) {
          if (sentAnything) {
            // Mid-stream failure: the client already has partial JSONL, so a
            // restart would corrupt it. Report instead.
            const detail = describeGeminiError(lastErr, lastModel);
            controller.enqueue(encoder.encode("\n" + JSON.stringify({ kind: "error", text: detail }) + '\n{"kind":"done"}\n'));
          } else {
            console.error("Every Gemini model failed — serving the offline analysis instead.");
            serveOffline();
          }
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" },
  });
}
