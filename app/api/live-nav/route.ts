import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit, getClientIp } from "@/lib/ratelimit";

export const maxDuration = 30;

// Free, no-key Indian mutual fund NAV API (data sourced daily from AMFI).
const MFAPI_BASE = "https://api.mfapi.in";

type SchemeRef = { schemeCode: number; schemeName: string };

// Cache the master scheme list in memory for an hour — it's large and changes rarely.
let schemeCache: { at: number; list: SchemeRef[] } | null = null;
const SCHEME_TTL = 60 * 60 * 1000;

async function getSchemes(): Promise<SchemeRef[]> {
  if (schemeCache && Date.now() - schemeCache.at < SCHEME_TTL) return schemeCache.list;
  const res = await fetch(`${MFAPI_BASE}/mf`, { cache: "no-store" });
  if (!res.ok) throw new Error("scheme list fetch failed");
  const list = (await res.json()) as SchemeRef[];
  schemeCache = { at: Date.now(), list };
  return list;
}

// Normalise a fund name for fuzzy matching: lowercase, drop plan/option words & punctuation.
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/direct|regular|growth|idcw|dividend|payout|reinvestment|plan|option|fund|scheme/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenScore(a: string, b: string): number {
  const ta = new Set(a.split(" ").filter(Boolean));
  const tb = new Set(b.split(" ").filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / Math.max(ta.size, tb.size);
}

// Prefer Direct + Growth when the user's name implies it, else best token overlap.
function bestMatch(name: string, schemes: SchemeRef[]): SchemeRef | null {
  const target = norm(name);
  const wantsDirect = /direct/i.test(name);
  const wantsGrowth = /growth/i.test(name);
  let best: SchemeRef | null = null;
  let bestScore = 0;
  for (const s of schemes) {
    let score = tokenScore(target, norm(s.schemeName));
    if (score < 0.5) continue;
    if (wantsDirect && /direct/i.test(s.schemeName)) score += 0.15;
    if (wantsGrowth && /growth/i.test(s.schemeName)) score += 0.1;
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return bestScore >= 0.5 ? best : null;
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  const rl = await checkRateLimit(ip);
  if (!rl.ok) return NextResponse.json({ error: rl.message }, { status: 429 });

  let names: unknown;
  try { ({ names } = await req.json()); } catch { return NextResponse.json({ error: "Invalid request." }, { status: 400 }); }
  if (!Array.isArray(names) || names.length === 0) return NextResponse.json({ error: "No fund names provided." }, { status: 400 });

  const wanted = (names as string[]).slice(0, 30).filter((n) => typeof n === "string");

  try {
    const schemes = await getSchemes();

    const results = await Promise.all(
      wanted.map(async (name) => {
        const match = bestMatch(name, schemes);
        if (!match) return { name, matched: false as const };
        try {
          const r = await fetch(`${MFAPI_BASE}/mf/${match.schemeCode}/latest`, { cache: "no-store" });
          if (!r.ok) return { name, matched: false as const };
          const data = (await r.json()) as { data?: { date: string; nav: string }[]; meta?: { scheme_name: string } };
          const latest = data.data?.[0];
          if (!latest) return { name, matched: false as const };
          return {
            name,
            matched: true as const,
            schemeName: data.meta?.scheme_name ?? match.schemeName,
            nav: Number(latest.nav),
            navDate: latest.date,
          };
        } catch {
          return { name, matched: false as const };
        }
      })
    );

    return NextResponse.json({ results });
  } catch (err) {
    console.error("live-nav error:", err);
    return NextResponse.json({ error: "Couldn't fetch live NAVs right now. Try again shortly." }, { status: 502 });
  }
}
