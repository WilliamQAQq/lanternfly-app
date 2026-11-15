# Spot-a-Lanternfly

A tiny citizen-science web app that lets anyone report a spotted lanternfly sighting in under 30 seconds. Built for a class project to help entomologists track invasive *Lycorma delicatula*.

**Live demo:** https://williamqaqq.github.io/lanternfly-app/

## What it does

- **3 quick questions** — What did you see? (Adult / Nymph / Egg mass) · How many? · How do you handle it?
- **Optional GPS** — one tap to share coordinates with researchers (shown locally on a Leaflet map; not publicly readable from the database)
- **Optional photo + On-device YOLO** — runs `models/best.onnx` directly in the browser via `onnxruntime-web` (WASM) to detect Adult, Early Nymph, and Late Nymph stages with bounding boxes; photos never leave the device
- **Optional AI check (Gemini Vision)** — uses `gemini-3.8-flash` (including Egg mass identification) with the user's own API key stored only in browser `localStorage`
- **Shared cloud DB** — submissions go to a Supabase Postgres table (`INSERT`-only for anonymous users)
- **Offline fallback** — if the cloud DB is unreachable, reports are saved locally in `localStorage`
- **Learn more & feedback** — curated links (Wikipedia, USDA APHIS, USDA NISIC, Penn State Extension) plus a Google Form for user feedback

## Tech stack

- **Frontend:** `index.html` + `app.js` (no build step) — semantic HTML/CSS/JS + Leaflet map
- **On-device ML:** `onnxruntime-web` (`1.20.1`) + `models/best.onnx` (YOLOv8n, 3 classes, 640×640 input)
- **AI (optional):** Google Gemini Vision (`gemini-3.8-flash`) — user pastes their own API key, stored only in their browser
- **Backend:** Supabase (Postgres + REST API) with Row-Level Security (`INSERT`-only for `anon` + `lantern_db_health()` RPC)
- **Hosting:** GitHub Pages — `index.html` at repo root is served directly

## Data model

Table: `lantern_reports`

| column | type | note |
|---|---|---|
| `id` | bigint | auto |
| `created_at` | timestamptz | auto |
| `client_id` | uuid | client-generated UUID with unique index for idempotent offline-sync deduplication |
| `stage` | text | Adult / Nymph / Egg mass / Not sure |
| `count` | text | 1 / 2-10 / 10+ |
| `action` | text | Killed it / Photo only / Just watched |
| `lat`, `lng` | text | optional GPS (numeric range checked; paired) |
| `place` | text | optional free-text place name (max 200 chars) |
| `ai_is_lanternfly`, `ai_stage`, `ai_confidence`, `ai_note` | — | optional YOLO / Gemini verdict |

Schema: [`supabase-schema.sql`](supabase-schema.sql) · Legacy AI migration: [`supabase-migration-ai.sql`](supabase-migration-ai.sql)

## How to run it yourself

1. Fork / clone this repo
2. Enable GitHub Pages: Settings → Pages → Source = `main` / root
3. (Optional own cloud DB) Create a free project at [supabase.com](https://supabase.com), run [`supabase-schema.sql`](supabase-schema.sql) in the SQL Editor, and replace `SUPABASE_URL` / `SUPABASE_ANON_KEY` in `app.js`:
   ```js
   const SUPABASE_URL = 'https://your-project.supabase.co';
   const SUPABASE_ANON_KEY = 'sb_publishable_...';
   ```
4. (Optional AI) Get a Gemini key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey) — visitors paste it into the form at runtime; it is never committed to the repo.

## Privacy & security notes

- `supabase-schema.sql` restricts anonymous visitors to `INSERT`-only and checks connectivity via a `security invoker` `lantern_db_health()` RPC; public `SELECT` and `DELETE` are disabled so exact GPS coordinates cannot be queried publicly and rows cannot be deleted by visitors. Named `CHECK` constraints enforce allowed values even for privileged writers.
- The Gemini API key stays in the visitor's browser `localStorage` and is sent directly to Google's API (`x-goog-api-key` header), never to Supabase.
- Never commit a Supabase *secret* key (`sb_secret_...`) — only the publishable anon key belongs in the frontend.
- **CSP & framing platform note:** Because GitHub Pages static hosting does not allow custom HTTP response headers, Content Security Policy is enforced via `<meta http-equiv="Content-Security-Policy">` in `index.html`. Per the CSP specification, `frame-ancestors` (and `X-Frame-Options`) cannot be enforced via `<meta>` tags; add HTTP response headers via a reverse proxy/CDN if framing must be blocked at the header level.

## Repo layout

```text
index.html                  # semantic HTML & CSS layout + strict CSP header
app.js                      # client-side logic, YOLO ONNX decoding, & offline sync queue
.nojekyll                   # disables Jekyll on GitHub Pages
images/spotted-lanternfly.jpg # public-domain USDA-ARS hero photo (Lycorma delicatula)
models/best.onnx            # 3-class YOLO ONNX model for browser inference
supabase-schema.sql         # table, hardened RLS policies, health-check RPC
supabase-migration-ai.sql   # standalone migration for adding AI columns
yolo-space/                 # optional Hugging Face Gradio Space (app.py + best.pt)
```

---

Class project — feedback welcome.
