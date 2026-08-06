# Portfolio X-Ray

An AI tool that reads an Indian investor's mutual fund statement (pasted text, a
text PDF, or a scanned PDF via OCR) and explains, in plain language and in real
time, what they actually own — holdings, allocation, a size treemap, live NAVs,
and sharp observations.

Built with Next.js + the **free** Google Gemini API. No paid API needed.

## Run locally — the 3 steps

1. Install dependencies:
   npm install

2. Get a FREE Gemini API key (no credit card):
   - Go to https://aistudio.google.com
   - Sign in with any Google account
   - Click "Get API key" → "Create API key"
   - Copy the key
   Then open `.env.local` and paste it in:
   GEMINI_API_KEY=your_real_key_here

3. Start it:
   npm run dev
   Open http://localhost:3000  (click "Try an example" to see it work)

## Deploy free (Vercel)

1. Push this folder to a GitHub repo.
2. Import it at https://vercel.com (free Hobby plan).
3. In Project → Settings → Environment Variables, add:
   GEMINI_API_KEY = your real key
4. Deploy. You get a live URL.

## What's inside

- app/page.tsx — the full UI: streaming results, donut, treemap, sortable
  holdings, live NAVs, copy/save, OCR flow, error recovery.
- app/api/analyze/route.ts — the AI logic (Gemini) + the system prompt. This is
  where analysis quality lives. Tweak the prompt to improve it.
- app/api/extract-pdf/route.ts — text extraction from PDFs (uses pdfjs).
- app/api/ocr-pdf/route.ts — OCR for scanned PDFs (Tesseract).
- app/api/live-nav/route.ts — today's NAVs from AMFI via free MFAPI.in.
- lib/ratelimit.ts — per-IP rate limiting.

## Free-tier notes (important & honest)

- The Gemini free tier needs no credit card, but has rate limits (roughly
  10-15 requests/minute). Fine for personal use and testing; if you hit a limit,
  wait a minute. The app shows a clear message if this happens.
- **Privacy:** on Gemini's free tier, Google may use submitted data to improve
  their products. For a portfolio tool that means pasted statements could be seen
  in training. Fine for testing/learning; tell real users before they paste real
  financial data, or upgrade to a paid tier (which doesn't train on your data).
- Live NAVs come from AMFI via MFAPI.in (free, no key). Your host must allow
  outbound calls to api.mfapi.in (Vercel does by default).

## Limits

- Covers mutual fund NAVs (not individual stocks).
- NAVs are end-of-day (that's the only NAV mutual funds have).
- Always verify AI output against official statements. Educational, not advice.
