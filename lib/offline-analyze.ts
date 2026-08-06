// Deterministic, no-API portfolio analysis.
//
// Produces exactly the same JSONL objects as the Gemini path, so the client
// renders it through the identical code path. Used as a fallback when Gemini is
// unavailable (quota, outage, missing key), or forced via ANALYZE_OFFLINE=1.
//
// It cannot match an LLM on messy free-form statements, but it never fails, never
// costs anything, and is completely predictable — which is what you want behind a
// live demo.

export type Line = Record<string, unknown>;

type Parsed = { name: string; value: number | null; type: HoldingType; regular: boolean };

type HoldingType = "Equity" | "Debt" | "Hybrid" | "ELSS" | "Index" | "Liquid" | "Stock" | "Gold" | "Other";

// Ordered: the first match wins, so narrow categories precede "Equity".
const TYPE_RULES: [RegExp, HoldingType][] = [
  [/\b(liquid|overnight|money\s*market)\b/i, "Liquid"],
  [/\b(gilt|g-?sec|bond|debt|corporate\s*bond|credit\s*risk|banking\s*(&|and)\s*psu|duration|income)\b/i, "Debt"],
  [/\b(elss|tax\s*saver|tax\s*saving)\b/i, "ELSS"],
  [/\b(index|nifty|sensex)\b/i, "Index"],
  [/\b(hybrid|balanced|equity\s*savings|multi\s*asset|asset\s*allocat)/i, "Hybrid"],
  [/\b(gold|silver)\b/i, "Gold"],
  [/\b(flexi|multi[\s-]*cap|large[\s-]*cap|mid[\s-]*cap|small[\s-]*cap|blue[\s-]*chip|focused|value|contra|dividend[\s-]*yield|opportunit|equity)/i, "Equity"],
];

// Lines that are headers, totals or notes rather than holdings.
const SKIP = /^\s*(consolidated|statement|folio|total|grand\s*total|sip\b|nominee|pan\b|date\b|scheme\s*name|portfolio|summary|holdings?\s*$)/i;

function classify(name: string): HoldingType {
  for (const [re, t] of TYPE_RULES) if (re.test(name)) return t;
  return "Other";
}

function parseAmount(line: string): number | null {
  const labelled = line.match(
    /(?:value|valuation|market\s*value|current\s*value|amount|balance)\s*[:\-]?\s*(?:rs\.?|inr|₹)?\s*([\d,]+(?:\.\d+)?)/i,
  );
  const raw = labelled ?? line.match(/(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d+)?)/i);
  if (!raw) return null;
  const n = Number(raw[1].replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseName(line: string): string {
  // Statements separate columns with | or multiple spaces; the name leads.
  let n = line.split("|")[0];
  n = n.replace(/\s{2,}.*$/, "");
  n = n.replace(/(?:value|valuation|units?|nav)\s*[:\-].*$/i, "");
  return n.trim().replace(/[,\-–|]+$/, "").trim();
}

export function parseStatement(text: string): Parsed[] {
  const out: Parsed[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || SKIP.test(line)) continue;

    const value = parseAmount(line);
    const name = parseName(line);
    if (!name || name.length < 4) continue;

    // Require either an explicit amount or clear fund/stock wording, so stray
    // prose doesn't become a phantom holding.
    const looksLikeHolding = value !== null || /\b(fund|etf|scheme|ltd|limited)\b/i.test(name);
    if (!looksLikeHolding) continue;

    out.push({ name, value, type: classify(name), regular: /\bregular\b/i.test(line) });
  }
  return out;
}

export function inr(n: number): string {
  const s = Math.round(n).toString();
  if (s.length <= 3) return `Rs ${s}`;
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3);
  return `Rs ${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}`;
}

// Split an equity holding across market-cap buckets from its name.
function capSplit(name: string): { large: number; mid: number; small: number } {
  // Indian fund names hyphenate freely ("Mid-Cap", "Blue-Chip"), so every gap
  // here must tolerate a hyphen as well as a space.
  if (/\bsmall[\s-]*cap\b/i.test(name)) return { large: 0, mid: 15, small: 85 };
  if (/\bmid[\s-]*cap\b/i.test(name)) return { large: 10, mid: 80, small: 10 };
  if (/\b(large[\s-]*cap|blue[\s-]*chip|nifty[\s-]*50|sensex|top[\s-]*100)\b/i.test(name)) return { large: 90, mid: 10, small: 0 };
  if (/\b(flexi|multi[\s-]*cap|focused|value|contra|opportunit)/i.test(name)) return { large: 60, mid: 28, small: 12 };
  return { large: 65, mid: 25, small: 10 };
}

const EQUITY_LIKE: HoldingType[] = ["Equity", "ELSS", "Index"];

export function analyseOffline(text: string): Line[] {
  const parsed = parseStatement(text);
  const lines: Line[] = [];

  if (parsed.length === 0) {
    return [
      {
        kind: "meta",
        totalValue: "Not stated",
        confidence: "low",
        verdict: "We couldn't read any holdings from this text.",
        riskLevel: "balanced",
        riskWhy: "Nothing was identified, so there's nothing to assess.",
        persona: "The Unknown",
        personaLine: "We need a clearer statement before we can describe this portfolio.",
        riskScore: 0,
        growthScore: 0,
        summary:
          "No fund or stock holdings could be identified in what was pasted. Try pasting the holdings section of your CAS or a broker report, with fund names and values on separate lines.",
        reassure:
          "Nothing has gone wrong with your portfolio — this is just a reading problem. | The text pasted didn't contain recognisable holdings. | Paste the holdings section and this will work.",
        worstThing: "We couldn't read the statement, so nothing has been assessed yet.",
        crashTest: "Not enough information to say how this portfolio would behave in a downturn.",
      },
      { kind: "done" },
    ];
  }

  const withValues = parsed.filter((p) => p.value !== null) as (Parsed & { value: number })[];
  const total = withValues.reduce((s, p) => s + p.value, 0);
  const known = total > 0;

  // ---- holdings -----------------------------------------------------------
  const pct = (v: number | null) => (known && v !== null ? (v / total) * 100 : null);

  for (const h of parsed) {
    const w = pct(h.value);
    lines.push({
      kind: "holding",
      name: h.name,
      type: h.type,
      value: h.value !== null ? inr(h.value) : "Not stated",
      weight: w !== null ? `${w.toFixed(1)}%` : "Unknown",
      plainEnglish: PLAIN[h.type],
    });
  }

  // ---- allocation ---------------------------------------------------------
  const byType = new Map<HoldingType, number>();
  for (const h of withValues) byType.set(h.type, (byType.get(h.type) ?? 0) + h.value);

  const alloc = [...byType.entries()]
    .map(([label, v]) => ({ label, percent: known ? Math.round((v / total) * 100) : 0 }))
    .sort((a, b) => b.percent - a.percent);

  for (const a of alloc) lines.push({ kind: "allocation", label: a.label, percent: a.percent, meaning: MEANING(a.label, a.percent) });

  const equityPct = alloc.filter((a) => EQUITY_LIKE.includes(a.label as HoldingType)).reduce((s, a) => s + a.percent, 0);
  const liquidPct = alloc.filter((a) => a.label === "Liquid").reduce((s, a) => s + a.percent, 0);

  // ---- equity market-cap breakdown ---------------------------------------
  const eq = withValues.filter((h) => EQUITY_LIKE.includes(h.type));
  const eqTotal = eq.reduce((s, h) => s + h.value, 0);
  if (eq.length && eqTotal > 0) {
    let large = 0, mid = 0, small = 0;
    for (const h of eq) {
      const s = capSplit(h.name);
      const w = h.value / eqTotal;
      large += s.large * w; mid += s.mid * w; small += s.small * w;
    }
    lines.push({ kind: "equityBreakdown", large: Math.round(large), mid: Math.round(mid), small: Math.round(small) });
  }

  // ---- overlap ------------------------------------------------------------
  const bucketOf = (n: string) =>
    /\b(large[\s-]*cap|blue[\s-]*chip|nifty|sensex|top[\s-]*100|index)\b/i.test(n) ? "large"
      : /\bmid[\s-]*cap\b/i.test(n) ? "mid"
      : /\bsmall[\s-]*cap\b/i.test(n) ? "small"
      : /\b(flexi|multi[\s-]*cap|focused)/i.test(n) ? "flexi" : "";

  const groups = new Map<string, string[]>();
  for (const h of eq) {
    const b = bucketOf(h.name);
    if (b) groups.set(b, [...(groups.get(b) ?? []), h.name]);
  }
  const dupe = [...groups.entries()].find(([, names]) => names.length >= 2);
  if (dupe) {
    lines.push({
      kind: "overlap",
      funds: dupe[1],
      text: "These funds sit in the same part of the market, so they likely own many of the same companies — you're less diversified than the number of funds suggests.",
    });
  }

  // ---- cost ---------------------------------------------------------------
  const anyRegular = parsed.some((p) => p.regular);
  if (known) {
    const rate = anyRegular ? 0.017 : 0.006;
    lines.push({
      kind: "cost",
      text: anyRegular
        ? `At least one holding looks like a Regular plan. On ${inr(total)} that's roughly ${inr(total * rate)} a year in fund fees — Direct plans of the same funds typically cost well under half that.`
        : `These look like Direct plans, so you're on the cheaper side — very roughly ${inr(total * rate)} a year in fund fees on ${inr(total)}.`,
    });
  }

  // ---- observations -------------------------------------------------------
  const obs: string[] = [];
  const biggest = withValues.slice().sort((a, b) => b.value - a.value)[0];
  if (biggest && known) {
    const bw = (biggest.value / total) * 100;
    if (bw >= 35) obs.push(`${biggest.name} alone is about ${bw.toFixed(0)}% of the portfolio — a single fund carrying that much means its performance largely decides yours.`);
  }
  if (equityPct >= 75) obs.push(`Roughly ${equityPct}% sits in equity. That's a growth-oriented mix, and it will move sharply in both directions.`);
  else if (equityPct > 0 && equityPct <= 35) obs.push(`Only about ${equityPct}% is in equity, so long-term growth will be modest — deliberate if that's the aim, worth revisiting if it isn't.`);
  if (liquidPct >= 15) obs.push(`About ${liquidPct}% is parked in liquid funds. Fine as an emergency buffer; if it's simply idle, it's earning far less than the rest.`);
  if (parsed.length <= 2) obs.push(`Only ${parsed.length} holding${parsed.length === 1 ? "" : "s"} were identified — a portfolio this concentrated depends heavily on very few decisions.`);
  if (anyRegular) obs.push("At least one Regular plan is present. The same fund in a Direct plan carries a lower expense ratio, and that gap compounds over the years.");
  if (obs.length < 3 && known) obs.push(`The portfolio totals ${inr(total)} across ${parsed.length} holdings, spread over ${alloc.length} asset type${alloc.length === 1 ? "" : "s"}.`);
  for (const t of obs.slice(0, 5)) lines.push({ kind: "observation", text: t });

  // ---- meta ---------------------------------------------------------------
  const riskScore = Math.max(0, Math.min(100, Math.round(equityPct * 0.85 + (100 - liquidPct) * 0.1)));
  const growthScore = Math.max(0, Math.min(100, Math.round(equityPct * 0.9)));
  const riskLevel = equityPct >= 70 ? "aggressive" : equityPct >= 40 ? "balanced" : "cautious";

  lines.unshift({
    kind: "meta",
    totalValue: known ? inr(total) : "Not stated",
    // Never claims high confidence: this is pattern-matching, not comprehension.
    confidence: known && parsed.length >= 2 ? "medium" : "low",
    verdict:
      equityPct >= 70
        ? "You're leaning hard into stocks — strong long-term growth potential, with a bumpy ride to match."
        : equityPct >= 40
        ? "A middle-of-the-road mix — some growth, some ballast, no extreme bets."
        : "This is a conservative, capital-first portfolio — steady, but slow to grow.",
    riskLevel,
    riskWhy: `About ${equityPct}% of the money sits in equity.`,
    persona: equityPct >= 70 ? "The Growth Seeker" : equityPct >= 40 ? "The Balanced Builder" : "The Cautious Saver",
    personaLine:
      equityPct >= 70
        ? "You're comfortable riding out swings in exchange for long-term growth."
        : equityPct >= 40
        ? "You want growth, but not at the cost of sleeping badly."
        : "You'd rather protect what you have than chase returns.",
    riskScore,
    growthScore,
    summary: `${parsed.length} holding${parsed.length === 1 ? "" : "s"} identified${known ? `, worth ${inr(total)}` : ""}. Roughly ${equityPct}% is in equity and ${100 - equityPct}% in everything else. Read as a structural breakdown of what you own, not a judgement on the specific funds.`,
    reassure: `${known ? `Your money is spread across ${parsed.length} holdings and ${alloc.length} asset type${alloc.length === 1 ? "" : "s"} — that structure is sound.` : "The structure of what you own looks readable and ordinary."} | The one thing to watch: ${biggest && known ? `${biggest.name} is your largest position at about ${((biggest.value / total) * 100).toFixed(0)}%.` : "how concentrated the largest holding is."} | Nothing here looks alarming — this is a normal portfolio shape.`,
    worstThing:
      biggest && known && (biggest.value / total) * 100 >= 35
        ? `${biggest.name} carries about ${((biggest.value / total) * 100).toFixed(0)}% of everything you own.`
        : equityPct >= 75
        ? "Almost everything is in equity, so a market fall hits nearly the whole portfolio at once."
        : "Nothing stands out as urgent in the structure of this portfolio.",
    crashTest:
      equityPct >= 70
        ? "If the market fell ~30%, a portfolio shaped like this could temporarily lose roughly a quarter to a third of its value. Steep — but historically these have recovered over a few years."
        : equityPct >= 40
        ? "If the market fell ~30%, this would likely drop somewhere in the mid-teens percent — uncomfortable, not devastating."
        : "If the market fell ~30%, this would likely dip only modestly. That protection is exactly what the lower equity share buys you.",
  });

  lines.push({
    kind: "nudge",
    text: dupe
      ? "Worth understanding: two of your funds may hold many of the same companies underneath."
      : anyRegular
      ? "Worth understanding: the difference between Regular and Direct plans of the same fund."
      : "Worth understanding: how much of your growth depends on your single largest holding.",
  });

  lines.push({ kind: "done" });
  return lines;
}

const PLAIN: Record<HoldingType, string> = {
  Equity: "A stock fund — it buys shares in companies, so it grows well over long periods but swings in the short term.",
  Debt: "A bond fund — it lends money out for interest. Steadier than stocks, with correspondingly smaller returns.",
  Hybrid: "A mix of stocks and bonds in one fund, aiming to smooth out the ride.",
  ELSS: "A tax-saving stock fund with a three-year lock-in on each investment.",
  Index: "A fund that simply tracks an index like the Nifty, at very low cost, rather than picking stocks.",
  Liquid: "A parking spot for cash — very safe, easy to withdraw, and low return.",
  Stock: "A direct shareholding in a single company.",
  Gold: "Gold exposure — usually held as a hedge rather than a growth engine.",
  Other: "We couldn't confidently categorise this one from its name alone.",
};

function MEANING(label: string, percent: number): string {
  switch (label) {
    case "Equity": return `${percent}% is in stocks — the growth engine, and the part that will swing with the market.`;
    case "Debt": return `${percent}% is in bonds, which steadies the portfolio when equity markets fall.`;
    case "Liquid": return `${percent}% is sitting in cash-like funds — safe and instantly available, but barely growing.`;
    case "Index": return `${percent}% tracks an index directly, which keeps costs low.`;
    case "ELSS": return `${percent}% is in tax-saving equity funds, each with a three-year lock-in.`;
    case "Hybrid": return `${percent}% is in mixed funds that hold both stocks and bonds.`;
    case "Gold": return `${percent}% is in gold, typically held as a hedge.`;
    case "Stock": return `${percent}% is in individual company shares, which concentrates risk more than funds do.`;
    default: return `${percent}% is in holdings we couldn't confidently categorise.`;
  }
}
