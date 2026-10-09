# Spot-a-Lanternfly

A tiny citizen-science web app that lets anyone report a spotted lanternfly sighting in under 30 seconds. Built for a class project to help entomologists track invasive *Lycorma delicatula*.

**Live demo:** https://williamqaqq.github.io/lanternfly-app/

## What it does

- **3 quick questions** — What did you see? (Adult / Nymph / Egg mass) · How many? · How do you handle it?
- **Optional GPS** — one tap to share coordinates with researchers (exact lat/lng hidden from public view for privacy)
- **Optional photo** — preview + **AI check** (Gemini Vision) that auto-suggests the life stage
- **Shared cloud DB** — all submissions go to a Supabase Postgres table so the whole class / judges see the same data live
- **Offline fallback** — if the cloud is unreachable it stores locally in the browser

## Tech stack

- **Frontend:** single-file `index.html` (no build step) — HTML/CSS/JS + Leaflet map
- **AI:** Google Gemini Vision (`gemini-2.0-flash`) — user pastes their own free API key, stored only in their browser, never uploaded
- **Backend:** Supabase (Postgres + auto REST API) with Row-Level Security policies for public read/insert
- **Hosting:** GitHub Pages — `index.html` at repo root is served directly

## Data model

Table: `lantern_reports`

| column | type | note |
|---|---|---|
| `id` | bigint | auto |
| `created_at` | timestamptz | auto |
| `stage` | text | Adult / Nymph / Egg mass / Not sure |
| `count` | text | 1 / 2-10 / 10+ |
| `action` | text | Killed it / Photo only / Just watched |
| `lat`, `lng` | text | optional GPS |
| `place` | text | optional free-text place name |
| `ai_is_lanternfly`, `ai_stage`, `ai_confidence`, `ai_note` | — | optional AI verdict |

Schema: [`supabase-schema.sql`](supabase-schema.sql) · AI columns migration: [`supabase-migration-ai.sql`](supabase-migration-ai.sql)

## How to run it yourself

1. Fork / clone this repo
2. Enable GitHub Pages: Settings → Pages → Source = `main` / root
3. (Optional cloud DB) create a free project at [supabase.com](https://supabase.com), run both `.sql` files in the SQL Editor, then paste your Project URL + publishable anon key into `index.html`:
   ```js
   const SUPABASE_URL = 'https://your-project.supabase.co';
   const SUPABASE_ANON_KEY = 'sb_publishable_...';
   ```
   Without this step it just runs in local-storage demo mode.
4. (Optional AI) get a free Gemini key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey) — users paste it into the form at runtime, it is never in the repo.

## Privacy notes

- GPS coordinates are saved only for researchers; the public page does not display exact coordinates.
- The Gemini API key stays in the visitor's browser `localStorage` and is only sent directly to Google, never to this project's database.
- Never commit a Supabase *secret* key (`sb_secret_...`) — only the publishable anon key belongs in the frontend, protected by RLS.

## Repo layout

```
index.html                  # the whole app (single file)
.nojekyll                   # disables Jekyll on GitHub Pages
supabase-schema.sql         # table + RLS policies
supabase-migration-ai.sql   # extra columns for AI verdicts
```

---

Class project — feedback welcome. Data shown in the demo is fictional.
