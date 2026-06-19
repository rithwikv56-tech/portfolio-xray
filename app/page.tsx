"use client";

import { useState, useRef, useMemo, memo, useCallback, useEffect } from "react";

type Holding = { name: string; type: string; value: string; weight: string; plainEnglish: string };
type Allocation = { label: string; percent: number; meaning?: string };
type RiskLevel = "cautious" | "balanced" | "aggressive";
type Meta = { totalValue: string; confidence: "high" | "medium" | "low"; summary: string; verdict?: string; riskLevel?: RiskLevel; riskWhy?: string; persona?: string; personaLine?: string; riskScore?: number; growthScore?: number };

const TYPE_COLORS: Record<string, string> = {
  Equity: "#1f7a52",
  Index: "#3f7cac",
  ELSS: "#6b5ca8",
  Hybrid: "#b8862f",
  Debt: "#c2902f",
  Liquid: "#0891b2",
  Stock: "#c25a4a",
  Gold: "#caa12f",
  Other: "#8a877e",
};
const colorFor = (t: string) => TYPE_COLORS[t] || TYPE_COLORS.Other;
const parseValue = (v: string) => Number(v.replace(/[^0-9.]/g, "")) || 0;

const DEMO_STATEMENT = `Consolidated Account Statement
HDFC Mid-Cap Opportunities Fund - Direct Growth | Units: 4,210.55 | NAV: 106.88 | Value: Rs 4,50,000
Parag Parikh Flexi Cap Fund - Direct Growth | Units: 4,820.10 | NAV: 66.39 | Value: Rs 3,20,000
SBI Liquid Fund - Direct Growth | Units: 27.10 | NAV: 3690.00 | Value: Rs 1,00,000
Axis Bluechip Fund - Direct Growth | Units: 1,995.00 | NAV: 50.12 | Value: Rs 1,00,000
SIP active on HDFC Mid-Cap (Rs 10,000/month) and Parag Parikh Flexi Cap (Rs 5,000/month)`;

type SortKey = "value" | "name" | "type";

export default function Home() {
  const [text, setText] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [uploadingPdf, setUploadingPdf] = useState(false);
  const [pdfName, setPdfName] = useState("");
  const [error, setError] = useState("");

  const [meta, setMeta] = useState<Meta | null>(null);
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [allocation, setAllocation] = useState<Allocation[]>([]);
  const [observations, setObservations] = useState<string[]>([]);
  const [nudge, setNudge] = useState<string>("");
  type EquityBreakdown = { large: number; mid: number; small: number };
  const [equityBreakdown, setEquityBreakdown] = useState<EquityBreakdown | null>(null);
  const [done, setDone] = useState(false);

  const [sortKey, setSortKey] = useState<SortKey>("value");
  const [copied, setCopied] = useState(false);
  const [scannedFile, setScannedFile] = useState<File | null>(null);
  const [ocrRunning, setOcrRunning] = useState(false);

  // Live NAV data: maps a holding name -> current NAV info fetched from MFAPI.
  const [liveNavs, setLiveNavs] = useState<Record<string, LiveNav>>({});
  const [navLoading, setNavLoading] = useState(false);

  // Q&A chat about the analysed portfolio.
  type ChatMsg = { role: "user" | "model"; text: string };
  const [chatMessages, setChatMessages] = useState<ChatMsg[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatStreaming, setChatStreaming] = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);

  function resetResults() {
    setMeta(null); setHoldings([]); setAllocation([]); setObservations([]); setDone(false);
    setNudge(""); setEquityBreakdown(null);
    setLiveNavs({}); setNavLoading(false);
    setChatMessages([]); setChatInput(""); setChatStreaming(false);
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(""); setUploadingPdf(true); setPdfName(""); setScannedFile(null);

    const isImage = file.type.startsWith("image/") || /\.(png|jpe?g|webp)$/i.test(file.name || "");

    try {
      const fd = new FormData();
      fd.append("file", file);
      // Both PDFs and screenshots go to Gemini vision — reads the file natively, works on Vercel.
      const res = await fetch("/api/read-file", { method: "POST", body: fd });

      // Guard against a non-JSON response (e.g. a server crash returning HTML).
      let data: { text?: string; error?: string };
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("application/json")) {
        data = await res.json();
      } else {
        const raw = await res.text();
        throw new Error(raw.slice(0, 120) || `Upload failed (status ${res.status}).`);
      }

      if (!res.ok) throw new Error(data.error || `Couldn't read that ${isImage ? "screenshot" : "PDF"} (status ${res.status}).`);
      if (!data.text) throw new Error(`No text could be read from that ${isImage ? "screenshot" : "PDF"}.`);
      setText(data.text); setPdfName(file.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : `Couldn't read that ${isImage ? "screenshot" : "PDF"}. Try pasting the text instead.`);
    } finally {
      setUploadingPdf(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function runOcr() {
    if (!scannedFile) return;
    setError(""); setOcrRunning(true);
    try {
      const fd = new FormData();
      fd.append("file", scannedFile);
      const res = await fetch("/api/ocr-pdf", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "OCR failed.");
      setText(data.text);
      setPdfName(`${scannedFile.name} (OCR${data.totalPages > data.pagesProcessed ? `, first ${data.pagesProcessed}/${data.totalPages} pages` : ""})`);
      setScannedFile(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "OCR failed. Please paste the text instead.");
    } finally {
      setOcrRunning(false);
    }
  }

  function loadDemo() { setText(DEMO_STATEMENT); setPdfName(""); setError(""); setScannedFile(null); }

  function handleLine(line: string, collectedNames?: string[]): string | null {
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(line); } catch { return null; }
    switch (obj.kind) {
      case "meta": setMeta({ totalValue: String(obj.totalValue ?? "Not stated"), confidence: (obj.confidence as Meta["confidence"]) ?? "low", summary: String(obj.summary ?? ""), verdict: obj.verdict ? String(obj.verdict) : undefined, riskLevel: (obj.riskLevel as RiskLevel) ?? undefined, riskWhy: obj.riskWhy ? String(obj.riskWhy) : undefined, persona: obj.persona ? String(obj.persona) : undefined, personaLine: obj.personaLine ? String(obj.personaLine) : undefined, riskScore: typeof obj.riskScore === "number" ? obj.riskScore : undefined, growthScore: typeof obj.growthScore === "number" ? obj.growthScore : undefined }); break;
      case "holding": {
        const h = obj as unknown as Holding;
        setHoldings((prev) => [...prev, h]);
        if (collectedNames && h.name) collectedNames.push(h.name);
        break;
      }
      case "allocation": setAllocation((a) => [...a, { label: String(obj.label), percent: Number(obj.percent) || 0, meaning: obj.meaning ? String(obj.meaning) : undefined }]); break;
      case "observation": setObservations((o) => [...o, String(obj.text)]); break;
      case "equityBreakdown": setEquityBreakdown({ large: Number(obj.large) || 0, mid: Number(obj.mid) || 0, small: Number(obj.small) || 0 }); break;
      case "nudge": setNudge(String(obj.text ?? "")); break;
      case "error": setError(String(obj.text)); break;
      case "done": setDone(true); break;
    }
    return typeof obj.kind === "string" ? obj.kind : null;
  }

  async function fetchLiveNavs(names: string[]) {
    if (names.length === 0) return;
    setNavLoading(true);
    try {
      const res = await fetch("/api/live-nav", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ names }),
      });
      if (!res.ok) return; // live NAV is enrichment; silent fail keeps core analysis intact
      const data = await res.json();
      const map: Record<string, { matched: boolean; schemeName?: string; nav?: number; navDate?: string }> = {};
      for (const r of data.results || []) map[r.name] = r;
      setLiveNavs(map);
    } catch {
      // ignore — enrichment only
    } finally {
      setNavLoading(false);
    }
  }

  async function analyze() {
    setError(""); resetResults(); setStreaming(true);
    const collectedNames: string[] = [];
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ statementText: text }),
      });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || "Analysis failed."); }
      if (!res.body) throw new Error("No response stream.");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "", sawDone = false, sawAnything = false;
      while (true) {
        const { done: sd, value } = await reader.read();
        if (sd) break;
        buffer += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line) { sawAnything = true; if (handleLine(line, collectedNames) === "done") sawDone = true; }
        }
      }
      if (buffer.trim()) { sawAnything = true; if (handleLine(buffer.trim(), collectedNames) === "done") sawDone = true; }
      if (!sawDone) {
        if (!sawAnything) setError("No response received. Please try again.");
        else { setError("The analysis was cut off before finishing — results may be incomplete."); setDone(true); }
      }
      // Enrich with live NAVs once we know the holdings (non-blocking for the core result).
      void fetchLiveNavs(collectedNames);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Analysis failed.");
    } finally {
      setStreaming(false);
    }
  }

  async function sendChat(question: string) {
    const q = question.trim();
    if (!q || chatStreaming) return;

    const baseMsgs: ChatMsg[] = [...chatMessages, { role: "user", text: q }];
    setChatMessages([...baseMsgs, { role: "model", text: "" }]);
    setChatInput("");
    setChatStreaming(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          context: {
            totalValue: meta?.totalValue,
            summary: [meta?.verdict, meta?.summary, meta?.riskLevel ? `Risk: ${meta.riskLevel}.` : ""].filter(Boolean).join(" "),
            holdings: holdings.map((h) => ({ name: h.name, type: h.type, value: h.value, weight: h.weight })),
            allocation,
            observations,
          },
          messages: baseMsgs,
        }),
      });
      if (!res.ok || !res.body) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || "Couldn't get an answer. Please try again.");
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = "";
      while (true) {
        const { done: sd, value } = await reader.read();
        if (sd) break;
        acc += decoder.decode(value, { stream: true });
        // Update the last (model) message as it streams.
        setChatMessages((prev) => {
          const copy = [...prev];
          copy[copy.length - 1] = { role: "model", text: acc };
          return copy;
        });
      }
      if (!acc.trim()) {
        setChatMessages((prev) => {
          const copy = [...prev];
          copy[copy.length - 1] = { role: "model", text: "Sorry — I didn't catch that. Could you rephrase?" };
          return copy;
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Something went wrong.";
      setChatMessages((prev) => {
        const copy = [...prev];
        copy[copy.length - 1] = { role: "model", text: msg };
        return copy;
      });
    } finally {
      setChatStreaming(false);
    }
  }

  const newAnalysis = useCallback(() => {
    resetResults(); setText(""); setPdfName(""); setError(""); setScannedFile(null);
  }, []);

  const copyResult = useCallback(() => {
    if (!meta) return;
    const lines = [
      `PORTFOLIO X-RAY`, `Total value: ${meta.totalValue} (${meta.confidence} confidence)`, ``,
      meta.summary, ``, `HOLDINGS`,
      ...holdings.map((h) => `• ${h.name} — ${h.value} (${h.type}, ${h.weight}) — ${h.plainEnglish}`), ``,
      `ALLOCATION`, ...allocation.map((a) => `• ${a.label}: ${a.percent}%`), ``,
      `WORTH NOTICING`, ...observations.map((o, i) => `${i + 1}. ${o}`), ``,
      `— Educational analysis, not investment advice.`,
    ];
    navigator.clipboard.writeText(lines.join("\n")).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800); });
  }, [meta, holdings, allocation, observations]);

  const downloadResult = useCallback(() => {
    if (!meta) return;
    const blob = new Blob([JSON.stringify({ meta, holdings, allocation, observations, generatedAt: new Date().toISOString() }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "portfolio-xray.json"; a.click();
    URL.revokeObjectURL(url);
  }, [meta, holdings, allocation, observations]);

  const sortedHoldings = useMemo(() => {
    if (streaming) return holdings;
    const copy = [...holdings];
    if (sortKey === "value") copy.sort((a, b) => parseValue(b.value) - parseValue(a.value));
    else if (sortKey === "name") copy.sort((a, b) => a.name.localeCompare(b.name));
    else copy.sort((a, b) => a.type.localeCompare(b.type));
    return copy;
  }, [holdings, sortKey, streaming]);

  const canGo = text.trim().length >= 20;
  const hasResults = meta !== null || streaming;
  const showEmptyState = done && holdings.length === 0;

  return (
    <main style={{ minHeight: "100vh", padding: "clamp(16px, 3vw, 28px)" }}>
      <div style={{ maxWidth: 1480, margin: "0 auto" }}>
        <div className="app-grid">
          {/* ===== SIDEBAR ===== */}
          <aside className="sidebar">
            <div className="tile" style={{ padding: 22, overflow: "hidden" }}>
              {/* brand */}
              <div style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 22 }}>
                <div style={{ width: 34, height: 34, borderRadius: 9, background: "var(--accent)", display: "grid", placeItems: "center", flexShrink: 0 }}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M6 5 L11 12 L6 19" stroke="#fff" strokeWidth="2.1" />
                    <path d="M18 5 L13 12 L18 19" stroke="#fff" strokeWidth="2.1" />
                    <circle cx="12" cy="12" r="1.9" fill="var(--cyan-bright)" />
                  </svg>
                </div>
                <div>
                  <div className="font-serif" style={{ fontWeight: 600, fontSize: 17, letterSpacing: "-0.01em", lineHeight: 1 }}>Portfolio X-Ray</div>
                  <div className="font-mono" style={{ fontSize: 10.5, color: "var(--ink-faint)", marginTop: 3 }}>FOR INDIAN INVESTORS</div>
                </div>
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <span style={{ fontSize: 13, fontWeight: 500 }}>Your statement</span>
                <button onClick={loadDemo} style={{ background: "none", border: "none", color: "var(--accent)", cursor: "pointer", fontSize: 12.5, fontWeight: 500, padding: 0 }}>Try example</button>
              </div>

              <textarea
                value={text}
                onChange={(e) => { setText(e.target.value); if (pdfName) setPdfName(""); }}
                placeholder="Paste your holdings — fund names, values, units. Or upload a PDF or screenshot below."
                style={{ width: "100%", minHeight: 150, background: "var(--paper-2)", border: "1px solid var(--line)", borderRadius: "var(--r-md)", padding: 13, color: "var(--ink)", fontSize: 13.5, fontFamily: "'JetBrains Mono', monospace", lineHeight: 1.5, resize: "vertical" }}
              />

              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 7 }}>
                <span className="font-mono" style={{ fontSize: 11, color: text.length > 55000 ? "var(--neg)" : "var(--ink-faint)" }}>{text.length.toLocaleString()} chars</span>
                {text && <button onClick={() => { setText(""); setPdfName(""); }} style={{ background: "none", border: "none", color: "var(--ink-faint)", cursor: "pointer", fontSize: 11.5 }}>clear</button>}
              </div>

              {pdfName && (
                <div className="fade-in" style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 10, fontSize: 12, color: "var(--ink-soft)" }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--pos)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{pdfName}</span>
                </div>
              )}

              <button
                onClick={analyze}
                disabled={!canGo || uploadingPdf || streaming}
                className="btn-primary btn-neon font-serif"
                style={{ width: "100%", borderRadius: 11, padding: "12px", fontSize: 15, fontWeight: 600, marginTop: 14, cursor: canGo && !uploadingPdf && !streaming ? "pointer" : "not-allowed", opacity: canGo && !uploadingPdf && !streaming ? 1 : 0.45, display: "flex", alignItems: "center", justifyContent: "center", gap: 9 }}
              >
                {streaming ? (<><span className="spin" style={{ width: 14, height: 14, border: "2px solid rgba(255,255,255,0.4)", borderTopColor: "#fff", borderRadius: "50%" }} /> Analyzing…</>) : "Analyze portfolio"}
              </button>

              <label className="btn-ghost" style={{ width: "100%", borderRadius: 11, padding: "11px", fontSize: 13.5, marginTop: 10, cursor: uploadingPdf ? "wait" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>
                {uploadingPdf ? "Reading…" : "Upload PDF or screenshot"}
                <input ref={fileRef} type="file" accept="application/pdf,image/png,image/jpeg,image/webp" onChange={handleFile} disabled={uploadingPdf} style={{ display: "none" }} />
              </label>
              <p style={{ fontSize: 11, color: "var(--ink-faint)", textAlign: "center", margin: "7px 0 0", lineHeight: 1.4 }}>
                Works with a Groww or Zerodha holdings screenshot too. Pasting text works best.
              </p>

              {error && (
                <div className="fade-in" style={{ marginTop: 12, background: "#fbeae7", border: "1px solid #eccfc9", borderRadius: 10, padding: "10px 12px" }}>
                  <div style={{ fontSize: 12.5, color: "#9c4436", lineHeight: 1.45 }}>{error}</div>
                  {scannedFile && (
                    <button onClick={runOcr} disabled={ocrRunning} className="btn-primary" style={{ marginTop: 10, borderRadius: 8, padding: "7px 14px", fontSize: 12.5, fontWeight: 500, cursor: ocrRunning ? "wait" : "pointer", display: "flex", alignItems: "center", gap: 7 }}>
                      {ocrRunning ? (<><span className="spin" style={{ width: 12, height: 12, border: "2px solid rgba(255,255,255,0.4)", borderTopColor: "#fff", borderRadius: "50%" }} /> Running OCR…</>) : "Run OCR on scan"}
                    </button>
                  )}
                </div>
              )}

              {done && meta && (
                <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                  <button onClick={copyResult} className="btn-ghost" style={{ flex: 1, borderRadius: "var(--r-sm)", padding: "8px", fontSize: 12, color: "var(--ink-soft)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                    {copied ? "Copied" : "Copy"}
                  </button>
                  <button onClick={downloadResult} className="btn-ghost" style={{ flex: 1, borderRadius: "var(--r-sm)", padding: "8px", fontSize: 12, color: "var(--ink-soft)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>Save</button>
                  <button onClick={newAnalysis} className="btn-ghost" style={{ flex: 1, borderRadius: "var(--r-sm)", padding: "8px", fontSize: 12, color: "var(--ink-soft)", cursor: "pointer" }}>New</button>
                </div>
              )}
            </div>

            {/* Fills the sidebar column so it doesn't leave empty space below */}
            <div className="tile" style={{ padding: 18, marginTop: 16 }}>
              <div className="font-mono" style={{ fontSize: 10.5, color: "var(--ink-faint)", letterSpacing: 0.5, marginBottom: 12 }}>HOW IT WORKS</div>
              {[
                ["Paste or upload", "Drop in a CAS, broker, or fund statement."],
                ["We read it live", "Holdings and allocation stream in as they're found."],
                ["See what matters", "Overlap, concentration, and tax angles, flagged."],
              ].map(([t, d], i) => (
                <div key={i} style={{ display: "flex", gap: 11, marginBottom: i === 2 ? 0 : 13 }}>
                  <span className="font-serif" style={{ fontSize: 14, fontWeight: 600, color: "var(--accent)", flexShrink: 0, width: 16 }}>{i + 1}</span>
                  <div>
                    <div style={{ fontSize: 12.5, fontWeight: 500 }}>{t}</div>
                    <div style={{ fontSize: 11.5, color: "var(--ink-faint)", lineHeight: 1.45, marginTop: 1 }}>{d}</div>
                  </div>
                </div>
              ))}
            </div>

            <div className="tile" style={{ padding: 16, marginTop: 16, display: "flex", gap: 10, alignItems: "flex-start" }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/></svg>
              <div style={{ fontSize: 11.5, color: "var(--ink-soft)", lineHeight: 1.5 }}>Your statement is sent only to generate this analysis — nothing is stored.</div>
            </div>

            <p className="font-mono" style={{ fontSize: 10.5, color: "var(--ink-faint)", lineHeight: 1.6, marginTop: 14, padding: "0 4px" }}>
              Educational analysis only — not investment advice. AI can misread statements; verify against official documents.
            </p>
          </aside>

          {/* ===== MAIN PANEL ===== */}
          <div>
            {!hasResults && <Welcome onDemo={loadDemo} />}
            {hasResults && (
              <Results
                meta={meta} holdings={sortedHoldings} allocation={allocation} observations={observations}
                streaming={streaming} done={done} showEmptyState={showEmptyState}
                sortKey={sortKey} setSortKey={setSortKey}
                liveNavs={liveNavs} navLoading={navLoading} nudge={nudge} equityBreakdown={equityBreakdown}
              />
            )}
            {done && meta && holdings.length > 0 && (
              <ChatPanel
                messages={chatMessages}
                input={chatInput}
                setInput={setChatInput}
                streaming={chatStreaming}
                onSend={sendChat}
              />
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

function Welcome({ onDemo }: { onDemo: () => void }) {
  return (
    <div className="tile fade-up" style={{ padding: "clamp(28px, 5vw, 52px)", display: "flex", flexDirection: "column", justifyContent: "center" }}>
      <div className="font-mono" style={{ fontSize: 12, color: "var(--accent)", letterSpacing: 1.5, marginBottom: 18 }}>● READY WHEN YOU ARE</div>
      <h1 className="font-serif" style={{ fontSize: "clamp(32px, 5vw, 52px)", lineHeight: 1.08, fontWeight: 600, margin: 0, letterSpacing: "-0.02em", maxWidth: 620 }}>
        See what your portfolio <em style={{ color: "var(--accent)", fontStyle: "italic" }}>actually</em> holds.
      </h1>
      <p style={{ marginTop: 20, fontSize: "clamp(15px, 2vw, 18px)", color: "var(--ink-soft)", lineHeight: 1.6, maxWidth: 540 }}>
        Paste or upload your mutual fund statement in the panel on the left. We&apos;ll break it down into plain language — every holding, your true allocation, and what&apos;s worth noticing — building live as it reads.
      </p>
      <div style={{ display: "flex", gap: 24, marginTop: 32, flexWrap: "wrap" }}>
        {[["Reads", "CAS, broker & fund PDFs"], ["Shows", "holdings, allocation, size"], ["Flags", "overlap, concentration, tax"]].map(([k, v], i) => (
          <div key={i} style={{ minWidth: 130 }}>
            <div className="font-serif" style={{ fontSize: 18, fontWeight: 600, color: "var(--accent)" }}>{k}</div>
            <div style={{ fontSize: 13, color: "var(--ink-soft)", marginTop: 2 }}>{v}</div>
          </div>
        ))}
      </div>
      <button onClick={onDemo} className="btn-ghost" style={{ alignSelf: "flex-start", marginTop: 32, borderRadius: 10, padding: "11px 20px", fontSize: 14, fontWeight: 500, cursor: "pointer" }}>
        See it with an example →
      </button>
    </div>
  );
}

type LiveNav = { matched: boolean; schemeName?: string; nav?: number; navDate?: string };

function Results({ meta, holdings, allocation, observations, streaming, done, showEmptyState, sortKey, setSortKey, liveNavs, navLoading, nudge, equityBreakdown }: {
  meta: Meta | null; holdings: Holding[]; allocation: Allocation[]; observations: string[];
  streaming: boolean; done: boolean; showEmptyState: boolean; sortKey: SortKey; setSortKey: (k: SortKey) => void;
  liveNavs: Record<string, LiveNav>; navLoading: boolean; nudge: string; equityBreakdown: { large: number; mid: number; small: number } | null;
}) {
  const conf = meta?.confidence ?? "low";
  const confColor = conf === "high" ? "var(--pos)" : conf === "medium" ? "var(--gold)" : "var(--neg)";
  const confLabel = conf === "high" ? "High confidence" : conf === "medium" ? "Medium confidence" : "Low confidence";
  const showTreemap = done && holdings.length >= 2 && holdings.some((h) => parseValue(h.value) > 0);

  return (
    <>
      {meta?.verdict && (
        <div className="tile fade-up" style={{ padding: "clamp(24px, 3.5vw, 36px)", marginBottom: "var(--sp-5)", background: "linear-gradient(135deg, #ffffff 0%, #fbfaf6 100%)", borderColor: "var(--line)", boxShadow: "0 2px 4px rgba(26,26,23,0.04), 0 12px 32px -12px rgba(26,26,23,0.14)", display: "flex", gap: "var(--sp-6)", alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 340px", minWidth: 0 }}>
            {meta.persona && (
              <div style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "var(--plum-soft)", border: "1px solid var(--plum)", color: "var(--plum)", borderRadius: "var(--r-pill)", padding: "3px 11px", fontSize: 11, fontWeight: 500, marginBottom: "var(--sp-4)" }}>
                <span style={{ fontSize: 11 }}>◆</span> {meta.persona}
              </div>
            )}
            <div className="font-mono label-soft" style={{ fontSize: 10, marginBottom: "var(--sp-3)" }}>THE BOTTOM LINE</div>
            <p className="font-serif" style={{ margin: 0, fontSize: "clamp(24px, 3.4vw, 34px)", lineHeight: 1.18, fontWeight: 600, letterSpacing: "-0.02em" }}>{meta.verdict}</p>
            {meta.personaLine && <p style={{ margin: "var(--sp-4) 0 0", fontSize: 14, color: "var(--ink-soft)", lineHeight: 1.5 }}>{meta.personaLine}</p>}
          </div>
          {meta.riskLevel && <RiskMeter level={meta.riskLevel} why={meta.riskWhy} />}
        </div>
      )}
      <div className="bento">
      {/* Total value tile */}
      <div className="tile fade-up col-2" style={{ padding: "var(--sp-5)", display: "flex", flexDirection: "column", justifyContent: "center", gap: "var(--sp-3)", minHeight: 128 }}>
        <div className="font-mono label-strong" style={{ fontSize: 10.5, color: "var(--ink-faint)" }}>TOTAL VALUE</div>
        {meta ? (
          <div>
            <div className="font-serif glitch-once grad-ink" style={{ fontSize: "clamp(28px, 3.2vw, 36px)", fontWeight: 600, letterSpacing: "-0.02em", lineHeight: 1 }}><CountUpValue value={meta.totalValue} /></div>
            <div style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: "var(--sp-3)", fontSize: 12, color: confColor }}>
              <span style={{ width: 6, height: 6, borderRadius: 50, background: confColor }} />{confLabel}
            </div>
          </div>
        ) : <div className="shimmer" style={{ height: 40, borderRadius: "var(--r-sm)" }} />}
      </div>

      {/* Summary tile */}
      <div className="tile fade-up col-4" style={{ padding: 24, minHeight: 128 }}>
        <div className="font-mono" style={{ fontSize: 11, color: "var(--ink-faint)", letterSpacing: 0.5, marginBottom: 10 }}>THE READ {streaming && <span style={{ color: "var(--accent)" }}>● live</span>}</div>
        {meta ? (
          <p className="font-serif" style={{ margin: 0, fontSize: "clamp(16px, 1.8vw, 19px)", lineHeight: 1.45, fontWeight: 500 }}>{meta.summary}</p>
        ) : <><div className="shimmer" style={{ height: 16, borderRadius: 6, marginBottom: 8 }} /><div className="shimmer" style={{ height: 16, borderRadius: 6, width: "80%" }} /></>}
      </div>

      {/* Allocation bar + Risk-vs-growth share a row to save height */}
      {allocation.length > 0 && (
        <div className="tile fade-up col-4" style={{ padding: 20 }}>
          <div className="font-mono" style={{ fontSize: 11, color: "var(--ink-faint)", letterSpacing: 0.5, marginBottom: 4 }}>WHERE YOUR MONEY IS</div>
          <p style={{ fontSize: 12, color: "var(--ink-faint)", margin: "0 0 14px" }}>The single biggest driver of both your returns and your risk.</p>
          <AllocationBar allocation={allocation} />
        </div>
      )}

      {showEmptyState && (
        <div className="tile fade-in col-6" style={{ padding: 28, textAlign: "center" }}>
          <p style={{ margin: 0, color: "var(--ink-soft)", fontSize: 14.5, lineHeight: 1.6 }}>
            No holdings found in that text — it may not be a portfolio statement. Try pasting the holdings section of your CAS, or use the example.
          </p>
        </div>
      )}

      {/* Risk vs growth — sits beside the allocation bar */}
      {done && meta?.riskScore != null && meta?.growthScore != null && (
        <div className="tile fade-up tile-interactive col-2" style={{ padding: 20 }}>
          <h3 className="font-serif" style={{ fontSize: 15, fontWeight: 600, margin: "0 0 4px" }}>Risk vs growth</h3>
          <p style={{ fontSize: 11.5, color: "var(--ink-faint)", margin: "0 0 12px" }}>Where your mix sits.</p>
          <RiskGrowthMap risk={meta.riskScore} growth={meta.growthScore} persona={meta.persona} />
        </div>
      )}

      {allocation.length > 0 && (
        <div className="tile fade-up tile-interactive col-3" style={{ padding: 20 }}>
          <h3 className="font-serif" style={{ fontSize: 16, fontWeight: 600, margin: "0 0 4px" }}>Allocation</h3>
          <p style={{ fontSize: 12, color: "var(--ink-faint)", margin: "0 0 14px" }}>How your money splits across types. Tap any row to learn what it means.</p>
          <AllocationView allocation={allocation} />
          {done && holdings.length > 0 && (() => {
            const m = portfolioMetrics(holdings);
            return (
              <div style={{ marginTop: "var(--sp-4)", paddingTop: "var(--sp-4)", borderTop: "1px solid var(--line-soft)", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--sp-4)" }}>
                <ConcentrationMeter topPct={m.topPct} topName={m.topName} />
                <DiversificationScore score={m.divScore} />
              </div>
            );
          })()}
        </div>
      )}

      {/* Equity breakdown — pairs beside Allocation */}
      {done && equityBreakdown && (equityBreakdown.large + equityBreakdown.mid + equityBreakdown.small) > 0 && (
        <div className="tile fade-up tile-interactive col-3" style={{ padding: 20 }}>
          <h3 className="font-serif" style={{ fontSize: 16, fontWeight: 600, margin: "0 0 4px" }}>Inside your equity</h3>
          <p style={{ fontSize: 12, color: "var(--ink-faint)", margin: "0 0 16px" }}>Your stock money split by company size — the real risk picture.</p>
          <EquityBreakdownBar data={equityBreakdown} />
          {done && meta && holdings.length > 0 && (() => {
            const m = portfolioMetrics(holdings);
            return (
              <div style={{ marginTop: "var(--sp-5)", paddingTop: "var(--sp-5)", borderTop: "1px solid var(--line-soft)" }}>
                <h4 className="font-serif" style={{ fontSize: 14, fontWeight: 600, margin: "0 0 2px" }}>If it keeps growing</h4>
                <p style={{ fontSize: 11.5, color: "var(--ink-faint)", margin: "0 0 12px" }}>A rough sense of the long game — not a prediction.</p>
                <GrowthProjection total={m.total} />
              </div>
            );
          })()}
        </div>
      )}

      {holdings.length > 0 && (
        <div className="tile fade-up tile-interactive col-6" style={{ padding: 20 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, flexWrap: "wrap", gap: 10 }}>
            <h3 className="font-serif" style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Holdings <span style={{ color: "var(--ink-faint)", fontWeight: 400 }}>· {holdings.length}</span></h3>
            {done && (
              <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <span className="font-mono" style={{ fontSize: 11, color: "var(--ink-faint)" }}>sort</span>
                {(["value", "name", "type"] as SortKey[]).map((k) => (
                  <button key={k} onClick={() => setSortKey(k)} className={`sort-toggle ${sortKey === k ? "active" : ""}`} style={{ background: sortKey === k ? "var(--accent-soft)" : "transparent", border: `1px solid ${sortKey === k ? "var(--accent)" : "var(--line)"}`, color: sortKey === k ? "var(--accent)" : "var(--ink-soft)", borderRadius: "var(--r-sm)", padding: "4px 10px", fontSize: 12, cursor: "pointer", textTransform: "capitalize" }}>{k}</button>
                ))}
              </div>
            )}
          </div>
          {done && (
            <div className="font-mono" style={{ fontSize: 10.5, color: navLoading ? "var(--accent)" : "var(--ink-faint)", marginBottom: 14 }}>
              {navLoading ? "● fetching live NAVs…" : Object.values(liveNavs).some((n) => n.matched) ? "● live NAVs from AMFI (today's prices)" : "statement values shown · live NAV unavailable"}
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column" }}>
            {holdings.map((h, i) => <HoldingRow key={h.name} h={h} last={i === holdings.length - 1} live={liveNavs[h.name]} />)}
          </div>
        </div>
      )}

      {/* Treemap full-width, short */}
      {showTreemap && (
        <div className="tile fade-up tile-interactive col-6" style={{ padding: 20 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16, flexWrap: "wrap", gap: 6 }}>
            <h3 className="font-serif" style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Holdings by size</h3>
            <p style={{ fontSize: 12, color: "var(--ink-faint)", margin: 0 }}>Each block scaled to its share of the portfolio.</p>
          </div>
          <Treemap holdings={holdings} />
        </div>
      )}

      {/* Observations full-width */}
      {observations.length > 0 && (
        <div className="tile fade-up col-6 halftone" style={{ padding: 24, background: "var(--ink)", color: "var(--paper)", borderColor: "var(--ink)", overflow: "hidden" }}>
          <h3 className="font-serif" style={{ fontSize: 16, fontWeight: 600, margin: "0 0 16px", color: "#fff", position: "relative", zIndex: 1 }}>Worth noticing</h3>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 16, position: "relative", zIndex: 1 }}>
            {observations.map((o, i) => (
              <div key={i} className="fade-up" style={{ display: "flex", gap: 12 }}>
                <span className="font-serif" style={{ color: "var(--accent-bright)", fontSize: 22, fontWeight: 600, lineHeight: 1, flexShrink: 0 }}>{String(i + 1).padStart(2, "0")}</span>
                <span style={{ fontSize: 13.5, lineHeight: 1.5, color: "#e8e6e0" }}>{o}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Gentle, non-pushy learning nudge */}
      {done && nudge && (
        <div className="tile fade-up col-6" style={{ padding: "16px 20px", display: "flex", alignItems: "center", gap: 13, background: "var(--accent-soft)", borderColor: "var(--accent)" }}>
          <span style={{ flexShrink: 0, width: 26, height: 26, borderRadius: 8, background: "var(--accent)", display: "grid", placeItems: "center", color: "#fff", fontSize: 15 }}>💡</span>
          <span style={{ fontSize: 13.5, lineHeight: 1.5, color: "var(--ink)" }}>{nudge}</span>
        </div>
      )}
      </div>
    </>
  );
}

const HoldingRow = memo(function HoldingRow({ h, last, live }: { h: Holding; last: boolean; live?: LiveNav }) {
  const [open, setOpen] = useState(false);
  const c = colorFor(h.type);
  const hasLive = live?.matched && live.nav != null;
  return (
    <div className="holding-row" onClick={() => setOpen((o) => !o)} style={{ cursor: "pointer", padding: "14px 8px", borderBottom: last ? "none" : "1px solid var(--line-soft)", borderRadius: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ width: 10, height: 10, borderRadius: 3, background: c, flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{h.name}</div>
          {(() => {
            const pctNum = Number((h.weight.match(/[\d.]+/)?.[0]) || 0);
            return pctNum > 0 ? (
              <div style={{ height: 4, background: "var(--line-soft)", borderRadius: 3, marginTop: 5, overflow: "hidden", maxWidth: 180 }}>
                <div style={{ width: `${Math.min(100, pctNum)}%`, height: "100%", background: c, borderRadius: 3, transition: "width .5s cubic-bezier(.16,1,.3,1)" }} />
              </div>
            ) : null;
          })()}
          {hasLive && <div className="font-sans" style={{ fontSize: 10.5, color: "var(--cyan)", marginTop: 4, fontWeight: 500 }}>NAV ₹{live!.nav!.toFixed(2)} · {live!.navDate}</div>}
        </div>
        <TypeChip type={h.type} />
        <div style={{ textAlign: "right", minWidth: 96 }}>
          <span className="font-serif" style={{ fontSize: 15, fontWeight: 600 }}>{h.value}</span>
          {h.weight !== "Unknown" && <span className="font-sans" style={{ fontSize: 11.5, color: "var(--ink-faint)", marginLeft: 6, fontWeight: 500 }}>{h.weight}</span>}
        </div>
      </div>
      {open && (
        <div className="fade-in" style={{ margin: "10px 0 2px 22px" }}>
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: "var(--ink-soft)" }}>{h.plainEnglish}</p>
          {hasLive && (
            <p className="font-sans" style={{ margin: "8px 0 0", fontSize: 11.5, color: "var(--cyan)", fontWeight: 500 }}>
              Today&apos;s NAV: ₹{live!.nav!.toFixed(2)} (as of {live!.navDate}), live from AMFI.
            </p>
          )}
        </div>
      )}
    </div>
  );
});

const AllocationView = memo(function AllocationView({ allocation }: { allocation: Allocation[] }) {
  const [openLabel, setOpenLabel] = useState<string | null>(null);
  const size = 168, stroke = 32, r = (size - stroke) / 2, cx = size / 2, cy = size / 2, circ = 2 * Math.PI * r;
  const total = allocation.reduce((s, a) => s + a.percent, 0) || 1;
  let offset = 0;
  const anyMeaning = allocation.some((a) => a.meaning);

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
      <div style={{ position: "relative", width: size, height: size }}>
        <svg className="donut-svg" width={size} height={size} style={{ transform: "rotate(-90deg)", ["--seg-hover-w" as string]: `${stroke + 4}px` }}>
          {allocation.map((a, i) => {
            const dash = (a.percent / total) * circ;
            const seg = (
              <circle key={i} className="seg" cx={cx} cy={cy} r={r} fill="none" stroke={colorFor(a.label)} strokeWidth={stroke}
                strokeDasharray={`${dash} ${circ - dash}`} strokeDashoffset={-offset}
                style={{ cursor: a.meaning ? "pointer" : "default" }}
                onClick={() => a.meaning && setOpenLabel(openLabel === a.label ? null : a.label)}>
                <title>{a.label}: {a.percent}%</title>
              </circle>
            );
            offset += dash;
            return seg;
          })}
        </svg>
        <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", textAlign: "center", pointerEvents: "none" }}>
          <div><div className="font-serif" style={{ fontSize: 30, fontWeight: 600, lineHeight: 1 }}>{allocation.length}</div><div className="font-sans" style={{ fontSize: 11, color: "var(--ink-faint)", marginTop: 2 }}>classes</div></div>
        </div>
      </div>
      {anyMeaning && <div style={{ fontSize: 11, color: "var(--cyan)", marginTop: -6 }}>tap a row to understand it</div>}
      <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: 2 }}>
        {allocation.map((a, i) => {
          const open = openLabel === a.label;
          return (
            <div key={i}>
              <div className="alloc-row" onClick={() => a.meaning && setOpenLabel(open ? null : a.label)}
                style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 7px", cursor: a.meaning ? "pointer" : "default", background: open ? "var(--paper-2)" : undefined }}>
                <span style={{ width: 9, height: 9, borderRadius: 2, background: colorFor(a.label), flexShrink: 0 }} />
                <span style={{ fontSize: 13, flex: 1 }}>{a.label}</span>
                <span className="font-serif" style={{ fontSize: 13.5, fontWeight: 600 }}>{a.percent}%</span>
                {a.meaning && <span style={{ fontSize: 13, color: "var(--ink-faint)", transform: open ? "rotate(90deg)" : "none", transition: "transform .15s", display: "inline-block", width: 12 }}>›</span>}
              </div>
              {open && a.meaning && (
                <p className="fade-in" style={{ margin: "2px 0 6px 24px", fontSize: 12.5, lineHeight: 1.5, color: "var(--ink-soft)" }}>{a.meaning}</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
});

const Treemap = memo(function Treemap({ holdings }: { holdings: Holding[] }) {
  const items = holdings.map((h) => ({ h, val: parseValue(h.value) })).filter((x) => x.val > 0).sort((a, b) => b.val - a.val);
  const total = items.reduce((s, x) => s + x.val, 0) || 1;
  if (items.length === 0) return null;

  // Each fund is a horizontal band whose HEIGHT is exactly its share of the
  // portfolio. flex-grow:val with basis:0 makes the heights perfectly
  // proportional — a 33% fund is literally ~3.3x the height of a 10% fund.
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)", height: 248 }}>
      {items.map(({ h, val }) => {
        const pct = (val / total) * 100; const c = colorFor(h.type);
        const tiny = pct < 12;
        return (
          <div key={h.name} className="tm-block"
            style={{ flexGrow: val, flexBasis: 0, minHeight: 0, background: `${c}24`, borderRadius: "var(--r-sm)", borderLeft: `4px solid ${c}`, padding: "6px 12px", display: "flex", flexDirection: tiny ? "row" : "column", alignItems: tiny ? "center" : "flex-start", justifyContent: "space-between", gap: 6, overflow: "hidden", cursor: "default" }}>
            <div style={{ minWidth: 0, display: "flex", flexDirection: tiny ? "row" : "column", alignItems: tiny ? "center" : "flex-start", gap: tiny ? 8 : 1 }}>
              <span className="font-sans" style={{ fontSize: 11.5, color: "var(--ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontWeight: 600 }}>{h.name}</span>
              {!tiny && <span className="font-sans" style={{ fontSize: 10, color: c, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.4 }}>{h.type}</span>}
            </div>
            <span className="font-serif" style={{ fontSize: tiny ? 13 : 18, fontWeight: 600, color: c, lineHeight: 1, flexShrink: 0 }}>{pct.toFixed(0)}%</span>
          </div>
        );
      })}
    </div>
  );
});

type ChatMsgT = { role: "user" | "model"; text: string };

const SUGGESTED = [
  "Is my portfolio too concentrated?",
  "What does my allocation say about my risk?",
  "Explain ELSS in simple terms",
];

function ChatPanel({ messages, input, setInput, streaming, onSend }: {
  messages: ChatMsgT[];
  input: string;
  setInput: (s: string) => void;
  streaming: boolean;
  onSend: (q: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  const canSend = input.trim().length > 0 && !streaming;

  return (
    <div className="tile fade-up halftone" style={{ marginTop: "var(--sp-5)", padding: "var(--sp-5)", background: "var(--ink)", borderColor: "var(--ink)", color: "var(--paper)", overflow: "hidden" }}>
      <div style={{ position: "relative", zIndex: 1 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 4 }}>
        <span style={{ width: 8, height: 8, borderRadius: 50, background: "var(--cyan-bright)", boxShadow: "0 0 8px var(--cyan-bright)" }} />
        <h3 className="font-serif" style={{ fontSize: 17, fontWeight: 600, margin: 0, color: "#fff" }}>Ask about your portfolio</h3>
      </div>
      <p style={{ fontSize: 12.5, color: "#b8b5ac", margin: "0 0 16px" }}>
        Questions about your holdings, allocation, or terms you don&apos;t know. Educational — not advice.
      </p>

      {messages.length > 0 && (
        <div ref={scrollRef} style={{ maxHeight: 340, overflowY: "auto", display: "flex", flexDirection: "column", gap: "var(--sp-3)", marginBottom: "var(--sp-4)", paddingRight: 4 }}>
          {messages.map((m, i) => (
            <div key={i} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start" }}>
              <div style={{
                maxWidth: "82%", padding: "10px 13px", borderRadius: "var(--r-md)", fontSize: 13.5, lineHeight: 1.5,
                background: m.role === "user" ? "var(--accent-bright)" : "rgba(255,255,255,0.07)",
                color: m.role === "user" ? "#fff" : "#ececec",
                border: m.role === "user" ? "none" : "1px solid rgba(255,255,255,0.12)",
                borderBottomRightRadius: m.role === "user" ? 4 : "var(--r-md)",
                borderBottomLeftRadius: m.role === "user" ? "var(--r-md)" : 4,
                whiteSpace: "pre-wrap",
              }}>
                {m.text || (streaming && i === messages.length - 1
                  ? <span style={{ display: "inline-flex", gap: 3 }}>
                      <span className="dot" style={{ animationDelay: "0ms", background: "#999" }} />
                      <span className="dot" style={{ animationDelay: "150ms", background: "#999" }} />
                      <span className="dot" style={{ animationDelay: "300ms", background: "#999" }} />
                    </span>
                  : "")}
              </div>
            </div>
          ))}
        </div>
      )}

      {messages.length === 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-2)", marginBottom: "var(--sp-4)" }}>
          {SUGGESTED.map((s) => (
            <button key={s} onClick={() => onSend(s)} disabled={streaming}
              style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: "var(--r-sm)", padding: "7px 12px", fontSize: 12.5, color: "#d8d5cc", cursor: streaming ? "wait" : "pointer", textAlign: "left", transition: "background .14s, border-color .14s" }}
              onMouseEnter={(e) => { if (!streaming) { e.currentTarget.style.background = "rgba(255,255,255,0.12)"; e.currentTarget.style.borderColor = "var(--cyan-bright)"; } }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.06)"; e.currentTarget.style.borderColor = "rgba(255,255,255,0.15)"; }}>
              {s}
            </button>
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: "var(--sp-2)" }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && canSend) onSend(input); }}
          placeholder="Ask anything about your portfolio…"
          disabled={streaming}
          style={{ flex: 1, background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: "var(--r-md)", padding: "11px 13px", fontSize: 13.5, color: "#fff" }}
        />
        <button
          onClick={() => canSend && onSend(input)}
          disabled={!canSend}
          style={{ background: "var(--cyan)", color: "#fff", border: "none", borderRadius: "var(--r-md)", padding: "0 18px", fontSize: 14, fontWeight: 500, cursor: canSend ? "pointer" : "not-allowed", opacity: canSend ? 1 : 0.5, display: "flex", alignItems: "center" }}
        >
          {streaming ? <span className="spin" style={{ width: 14, height: 14, border: "2px solid rgba(255,255,255,0.4)", borderTopColor: "#fff", borderRadius: "50%" }} /> : "Send"}
        </button>
      </div>
      </div>
    </div>
  );
}

function RiskMeter({ level, why }: { level: RiskLevel; why?: string }) {
  const stops: { key: RiskLevel; label: string; color: string }[] = [
    { key: "cautious", label: "Cautious", color: "#3f7cac" },
    { key: "balanced", label: "Balanced", color: "#b8862f" },
    { key: "aggressive", label: "Aggressive", color: "#c25a4a" },
  ];
  const idx = stops.findIndex((s) => s.key === level);
  const active = stops[idx] || stops[1];
  const pos = idx === 0 ? 16.6 : idx === 2 ? 83.3 : 50;

  return (
    <div style={{ flex: "0 0 270px", minWidth: 250 }}>
      <div className="font-mono label-strong" style={{ fontSize: 10, marginBottom: "var(--sp-3)" }}>RISK LEVEL</div>
      <div style={{ position: "relative", height: 16, borderRadius: "var(--r-pill)", background: "linear-gradient(90deg, #3f7cac 0%, #b8862f 50%, #c25a4a 100%)", marginTop: 22 }}>
        {/* "you are here" marker — pin with label above */}
        <div style={{ position: "absolute", top: "50%", left: `${pos}%`, transform: "translate(-50%, -50%)", transition: "left .45s cubic-bezier(.16,1,.3,1)" }}>
          <div style={{ position: "absolute", bottom: 18, left: "50%", transform: "translateX(-50%)", whiteSpace: "nowrap", fontSize: 11, fontWeight: 700, color: active.color }}>{active.label}</div>
          <div style={{ width: 24, height: 24, borderRadius: "50%", background: "#fff", border: `4px solid ${active.color}`, boxShadow: "0 2px 6px rgba(0,0,0,0.22)" }} />
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: "var(--sp-2)" }}>
        {stops.map((s) => (
          <span key={s.key} style={{ fontSize: 10, fontWeight: s.key === level ? 600 : 400, color: s.key === level ? active.color : "var(--ink-muted)" }}>{s.label}</span>
        ))}
      </div>
      {why && <p style={{ margin: "var(--sp-3) 0 0", fontSize: 12.5, color: "var(--ink-soft)", lineHeight: 1.45 }}>{why}</p>}
    </div>
  );
}

// Animated count-up for the rupee value (parses the number, animates, keeps formatting).
function CountUpValue({ value }: { value: string }) {
  const [display, setDisplay] = useState(value);
  useEffect(() => {
    const target = Number((value.match(/[\d,]+(\.\d+)?/)?.[0] || "").replace(/,/g, ""));
    if (!target || Number.isNaN(target)) { setDisplay(value); return; }
    const prefix = value.slice(0, value.search(/[\d]/));
    const dur = 700, start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      const cur = Math.round(target * eased);
      setDisplay(prefix + cur.toLocaleString("en-IN"));
      if (t < 1) raf = requestAnimationFrame(tick);
      else setDisplay(value);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{display}</>;
}

// A wide colorful stacked bar — the at-a-glance allocation read.
function AllocationBar({ allocation }: { allocation: Allocation[] }) {
  const total = allocation.reduce((s, a) => s + a.percent, 0) || 1;
  return (
    <div>
      <div style={{ display: "flex", height: 46, borderRadius: "var(--r-md)", overflow: "hidden", border: "1px solid var(--line)", boxShadow: "inset 0 1px 3px rgba(0,0,0,0.08)" }}>
        {allocation.map((a, i) => {
          const w = (a.percent / total) * 100;
          const c = colorFor(a.label);
          return (
            <div key={i} title={`${a.label}: ${a.percent}%`}
              style={{ width: `${w}%`, background: `linear-gradient(180deg, ${c} 0%, ${c}dd 100%)`, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "#fff", minWidth: 0, overflow: "hidden", whiteSpace: "nowrap", padding: "0 4px", lineHeight: 1.1, boxShadow: i > 0 ? "inset 1px 0 0 rgba(255,255,255,0.15)" : "none" }}>
              {w > 16 && <span style={{ fontSize: 10.5, fontWeight: 500, opacity: 0.92 }}>{a.label}</span>}
              {w > 8 && <span style={{ fontSize: w > 16 ? 12 : 11, fontWeight: 700 }}>{a.percent}%</span>}
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 16px", marginTop: 12 }}>
        {allocation.map((a, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: colorFor(a.label) }} />
            <span style={{ fontSize: 12.5, color: "var(--ink-soft)" }}>{a.label} <strong style={{ color: "var(--ink)" }}>{a.percent}%</strong></span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Risk vs growth positioning map — where this portfolio sits.
function RiskGrowthMap({ risk, growth, persona }: { risk: number; growth: number; persona?: string }) {
  const x = Math.max(4, Math.min(96, risk));
  const y = Math.max(4, Math.min(96, growth));
  return (
    <div>
      <div style={{ position: "relative", width: "100%", aspectRatio: "1 / 1", maxWidth: 240, margin: "0 auto", background: "linear-gradient(135deg, #eef4f1 0%, #fbf2ee 100%)", borderRadius: 14, border: "1px solid var(--line)", overflow: "hidden" }}>
        {/* quadrant lines */}
        <div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 1, background: "var(--line)" }} />
        <div style={{ position: "absolute", top: "50%", left: 0, right: 0, height: 1, background: "var(--line)" }} />
        {/* axis labels */}
        <span style={{ position: "absolute", top: 6, left: 8, fontSize: 9.5, color: "var(--ink-faint)" }}>High growth</span>
        <span style={{ position: "absolute", bottom: 6, left: 8, fontSize: 9.5, color: "var(--ink-faint)" }}>Low growth</span>
        <span style={{ position: "absolute", bottom: 6, right: 8, fontSize: 9.5, color: "var(--ink-faint)" }}>High risk</span>
        <span style={{ position: "absolute", bottom: 22, left: 8, fontSize: 9.5, color: "var(--ink-faint)" }}>Low risk</span>
        {/* the dot */}
        <div style={{ position: "absolute", left: `${x}%`, bottom: `${y}%`, transform: "translate(-50%, 50%)", width: 22, height: 22, borderRadius: "50%", background: "var(--cyan)", border: "3px solid #fff", boxShadow: "0 0 0 1px var(--cyan), 0 0 14px rgba(6,182,212,0.55)", transition: "left .6s cubic-bezier(.16,1,.3,1), bottom .6s cubic-bezier(.16,1,.3,1)" }} />
      </div>
      {persona && <div style={{ textAlign: "center", marginTop: 12, fontSize: 12.5, color: "var(--ink-soft)" }}>You sit here: <strong style={{ color: "var(--ink)" }}>{persona}</strong></div>}
    </div>
  );
}

// Plain-English definitions, shown only on tap — depth without clutter.
const GLOSSARY: Record<string, string> = {
  Equity: "Money invested in company shares (stocks). Higher growth over time, but the value swings up and down more.",
  Index: "A fund that simply copies a market index like the Nifty 50. Low cost, no fund manager picking stocks.",
  ELSS: "A tax-saving equity fund. You get a tax deduction, but your money is locked in for 3 years.",
  Hybrid: "A mix of stocks and bonds in one fund — a middle path between growth and safety.",
  Debt: "Money lent out (bonds, etc.). Steadier and safer than stocks, but lower long-term growth.",
  Liquid: "A near-cash fund for parking money short-term. Very safe, very low return — a buffer, not a growth engine.",
  Stock: "A direct share in a single company — you own a piece of that one business.",
  Gold: "A fund tracking the price of gold. Often used as a hedge when markets fall.",
  Other: "A holding that doesn't fit the usual fund types.",
  SIP: "Systematic Investment Plan — investing a fixed amount every month automatically.",
  NAV: "Net Asset Value — the price of one unit of a mutual fund, updated once a day.",
};

function InfoTerm({ term, children }: { term: string; children?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const def = GLOSSARY[term];
  if (!def) return <>{children || term}</>;
  return (
    <span style={{ position: "relative", display: "inline-block" }}>
      <span
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        style={{ cursor: "help", borderBottom: "1px dotted var(--ink-faint)", whiteSpace: "nowrap" }}
        title="Tap to learn"
      >
        {children || term}
        <span style={{ fontSize: 9, color: "var(--cyan)", verticalAlign: "super", marginLeft: 1 }}>?</span>
      </span>
      {open && (
        <>
          <span onClick={(e) => { e.stopPropagation(); setOpen(false); }} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
          <span className="fade-in" style={{ position: "absolute", bottom: "calc(100% + 8px)", left: 0, zIndex: 41, width: 230, background: "var(--ink)", color: "var(--paper)", fontSize: 12, lineHeight: 1.5, padding: "10px 12px", borderRadius: 10, boxShadow: "0 6px 24px rgba(0,0,0,0.25)", fontWeight: 400, whiteSpace: "normal" }}>
            <strong style={{ color: "#fff" }}>{term}:</strong> {def}
          </span>
        </>
      )}
    </span>
  );
}

// TypeChip uses the GLOSSARY defined above to explain a fund type on tap.
function TypeChip({ type }: { type: string }) {
  const [open, setOpen] = useState(false);
  const c = colorFor(type);
  const def = GLOSSARY[type];
  return (
    <span style={{ position: "relative", display: "inline-block" }}>
      <span
        onClick={(e) => { e.stopPropagation(); if (def) setOpen((o) => !o); }}
        style={{ fontSize: 10.5, fontWeight: 500, color: c, background: `${c}14`, border: `1px solid ${c}33`, borderRadius: 5, padding: "2px 7px", whiteSpace: "nowrap", cursor: def ? "help" : "default", display: "inline-flex", alignItems: "center", gap: 3 }}>
        {type}{def && <span style={{ opacity: 0.6, fontSize: 9 }}>ⓘ</span>}
      </span>
      {open && def && (
        <span className="fade-in" onClick={(e) => e.stopPropagation()}
          style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 20, width: 220, background: "var(--ink)", color: "var(--paper)", fontSize: 11.5, lineHeight: 1.5, padding: "9px 11px", borderRadius: 9, boxShadow: "0 6px 20px rgba(0,0,0,0.25)", fontWeight: 400, whiteSpace: "normal", textAlign: "left" }}>
          {def}
        </span>
      )}
    </span>
  );
}

// ---- Derived metrics computed from holdings (no AI, fully reliable) ----
function portfolioMetrics(holdings: Holding[]) {
  const vals = holdings.map((h) => ({ name: h.name, type: h.type, val: parseValue(h.value) })).filter((x) => x.val > 0);
  const total = vals.reduce((s, x) => s + x.val, 0) || 1;
  const sorted = [...vals].sort((a, b) => b.val - a.val);
  const topPct = sorted.length ? (sorted[0].val / total) * 100 : 0;
  const topName = sorted.length ? sorted[0].name : "";
  // Herfindahl-based diversification: 1 = one holding, lower = more spread.
  const hhi = vals.reduce((s, x) => s + Math.pow(x.val / total, 2), 0);
  // Map HHI (1/n .. 1) to a friendly 0-10 score. More holdings + even split = higher.
  const n = vals.length || 1;
  const minHHI = 1 / n;
  const evenness = n > 1 ? (1 - (hhi - minHHI) / (1 - minHHI)) : 0; // 1 = perfectly even
  const spread = Math.min(1, n / 8); // having more funds helps, saturating at ~8
  const divScore = Math.round(Math.max(0, Math.min(10, (evenness * 0.6 + spread * 0.4) * 10)));
  return { total, topPct, topName, divScore, count: vals.length };
}

// Concentration meter — how much rides on the single biggest holding.
function ConcentrationMeter({ topPct, topName }: { topPct: number; topName: string }) {
  const pct = Math.round(topPct);
  const zone = pct >= 40 ? { c: "var(--coral)", word: "High" } : pct >= 25 ? { c: "var(--gold)", word: "Moderate" } : { c: "var(--accent)", word: "Spread out" };
  return (
    <div>
      <div className="font-mono label-strong" style={{ fontSize: 10, marginBottom: "var(--sp-3)" }}>BIGGEST SINGLE BET</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span className="font-serif" style={{ fontSize: 30, fontWeight: 600, color: zone.c, lineHeight: 1 }}>{pct}%</span>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: zone.c }}>{zone.word}</span>
      </div>
      <div style={{ height: 8, background: "var(--line-soft)", borderRadius: "var(--r-pill)", marginTop: 10, overflow: "hidden" }}>
        <div style={{ width: `${Math.min(100, pct)}%`, height: "100%", background: zone.c, borderRadius: "var(--r-pill)", transition: "width .5s cubic-bezier(.16,1,.3,1)" }} />
      </div>
      <p style={{ margin: "10px 0 0", fontSize: 12, color: "var(--ink-soft)", lineHeight: 1.45 }}>
        {pct}% of everything sits in one fund{topName ? ` (${topName.split(" ").slice(0, 3).join(" ")}…)` : ""}. The more that one bet, the more your whole portfolio rides on it.
      </p>
    </div>
  );
}

// Diversification score — one friendly number out of 10.
function DiversificationScore({ score }: { score: number }) {
  const c = score >= 7 ? "var(--accent)" : score >= 4 ? "var(--gold)" : "var(--coral)";
  const word = score >= 7 ? "Well spread" : score >= 4 ? "Somewhat concentrated" : "Concentrated";
  return (
    <div>
      <div className="font-mono label-strong" style={{ fontSize: 10, marginBottom: "var(--sp-3)" }}>DIVERSIFICATION</div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ position: "relative", width: 56, height: 56, flexShrink: 0 }}>
          <svg width="56" height="56" style={{ transform: "rotate(-90deg)" }}>
            <circle cx="28" cy="28" r="23" fill="none" stroke="var(--line-soft)" strokeWidth="6" />
            <circle cx="28" cy="28" r="23" fill="none" stroke={c} strokeWidth="6" strokeLinecap="round"
              strokeDasharray={`${(score / 10) * 2 * Math.PI * 23} ${2 * Math.PI * 23}`} style={{ transition: "stroke-dasharray .6s cubic-bezier(.16,1,.3,1)" }} />
          </svg>
          <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
            <span className="font-serif" style={{ fontSize: 17, fontWeight: 600, color: c }}>{score}<span style={{ fontSize: 10, color: "var(--ink-faint)" }}>/10</span></span>
          </div>
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: c }}>{word}</div>
          <p style={{ margin: "2px 0 0", fontSize: 11.5, color: "var(--ink-soft)", lineHeight: 1.4 }}>Money spread across more, evenly-sized holdings.</p>
        </div>
      </div>
    </div>
  );
}

// Equity broken into market-cap buckets — the real risk picture, shown simply.
function EquityBreakdownBar({ data }: { data: { large: number; mid: number; small: number } }) {
  const total = data.large + data.mid + data.small || 1;
  const parts = [
    { key: "Large-cap", pct: (data.large / total) * 100, c: "#2f7d6b", note: "Big, stable companies" },
    { key: "Mid-cap", pct: (data.mid / total) * 100, c: "#1f7a52", note: "Faster growth, more swings" },
    { key: "Small-cap", pct: (data.small / total) * 100, c: "#9cc049", note: "Highest risk & potential" },
  ].filter((p) => p.pct > 0.5);
  return (
    <div>
      <div style={{ display: "flex", height: 40, borderRadius: "var(--r-md)", overflow: "hidden", border: "1px solid var(--line)", boxShadow: "inset 0 1px 3px rgba(0,0,0,0.08)" }}>
        {parts.map((p, i) => (
          <div key={i} title={`${p.key}: ${Math.round(p.pct)}%`}
            style={{ width: `${p.pct}%`, background: `linear-gradient(180deg, ${p.c}, ${p.c}dd)`, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 12, fontWeight: 700, minWidth: 0, boxShadow: i > 0 ? "inset 1px 0 0 rgba(255,255,255,0.18)" : "none" }}>
            {p.pct > 12 ? `${Math.round(p.pct)}%` : ""}
          </div>
        ))}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 18px", marginTop: 12 }}>
        {parts.map((p, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: p.c }} />
            <span style={{ fontSize: 12.5, color: "var(--ink-soft)" }}><strong style={{ color: "var(--ink)" }}>{p.key}</strong> · {p.note}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Illustrative growth projection — clearly labeled as illustrative, not a prediction.
function GrowthProjection({ total }: { total: number }) {
  if (!total) return null;
  const years = [0, 5, 10, 15, 20];
  // Illustrative annual returns (conservative / typical equity-heavy long-run).
  const low = 0.08, high = 0.12;
  const W = 460, H = 180, padL = 8, padR = 8, padT = 14, padB = 22;
  const maxVal = total * Math.pow(1 + high, 20);
  const xOf = (yr: number) => padL + (yr / 20) * (W - padL - padR);
  const yOf = (v: number) => padT + (1 - v / maxVal) * (H - padT - padB);
  const lineLow = years.map((y) => `${xOf(y)},${yOf(total * Math.pow(1 + low, y))}`).join(" ");
  const lineHigh = years.map((y) => `${xOf(y)},${yOf(total * Math.pow(1 + high, y))}`).join(" ");
  const areaPath = `M ${years.map((y) => `${xOf(y)},${yOf(total * Math.pow(1 + high, y))}`).join(" L ")} L ${years.slice().reverse().map((y) => `${xOf(y)},${yOf(total * Math.pow(1 + low, y))}`).join(" L ")} Z`;
  const fmt = (v: number) => "₹" + (v >= 1e7 ? (v / 1e7).toFixed(1) + " Cr" : (v / 1e5).toFixed(1) + " L");
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}>
        <path d={areaPath} fill="var(--accent)" opacity="0.1" />
        <polyline points={lineHigh} fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        <polyline points={lineLow} fill="none" stroke="var(--accent)" strokeWidth="2" strokeDasharray="4 4" opacity="0.7" strokeLinecap="round" />
        {years.filter((y) => y > 0).map((y) => (
          <text key={y} x={xOf(y)} y={H - 6} textAnchor="middle" fontSize="10" fill="var(--ink-faint)" fontFamily="'JetBrains Mono', monospace">{y}y</text>
        ))}
        <circle cx={xOf(20)} cy={yOf(total * Math.pow(1 + high, 20))} r="3.5" fill="var(--accent)" />
        <circle cx={xOf(20)} cy={yOf(total * Math.pow(1 + low, 20))} r="3" fill="var(--accent)" opacity="0.7" />
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontSize: 12.5 }}>
        <span style={{ color: "var(--ink-soft)" }}>In 20 years, this could grow to roughly</span>
        <span className="font-serif" style={{ fontWeight: 600 }}>{fmt(total * Math.pow(1 + low, 20))} – {fmt(total * Math.pow(1 + high, 20))}</span>
      </div>
      <p style={{ margin: "8px 0 0", fontSize: 11, color: "var(--ink-faint)", lineHeight: 1.45 }}>
        Illustrative only, assuming 8–12% average annual returns with no withdrawals. Real returns vary and are never guaranteed.
      </p>
    </div>
  );
}
