# Mic Studio

AI video generation app in the shape of Leonardo.AI, running a single model:
**Kling 3.0**. It can be driven through fal.ai (instant signup) or the official
Kuaishou Open Platform — `PROVIDER` picks which.

```bash
cp .env.example .env.local   # Supabase keys + PROVIDER + that provider's key
npm install
npm run dev                  # http://localhost:3000
```

Run `supabase/migrations/0001_init.sql` in your Supabase SQL editor first.

Full setup, data model, cost math and the async-job design are in
[ARCHITECTURE.md](./ARCHITECTURE.md).

## Providers

| `PROVIDER=` | Needs | Notes |
|---|---|---|
| `fal` | `FAL_KEY` | fal.ai resells Kling 3.0. Instant signup, pay-as-you-go. |
| `kling` | `KLING_ACCESS_KEY` + `KLING_SECRET_KEY` | Official. Best pricing, verified business account required. |
| `mock` | nothing | Placeholder clips from `public/mock`. No network. |

Switching is a restart, not a code change. In-flight jobs keep polling whichever
service created them.

## Layout

```
src/
  app/
    page.tsx                     landing
    login/                       magic link + Google
    studio/                      the app
    api/generate/                submit a job
    api/generations/             gallery + read-through refresh
    api/webhooks/fal|kling/      provider callbacks
    api/cron/poll/               safety-net sweep
  components/
    Studio.tsx                   layout + polling state
    Composer.tsx                 prompt + settings panel
    GenerationCard.tsx           gallery tile (hover-to-play)
    VideoModal.tsx               full-size player
  lib/
    providers/
      types.ts                   the VideoProvider interface
      fal.ts  kling.ts  mock.ts  one adapter each
      index.ts                   registry + resolution
    models.ts                    model registry + pricing
    generations.ts               idempotent status reconciliation
    supabase/                    browser / server / service-role clients
public/mock/                     placeholder clips for PROVIDER=mock
supabase/migrations/0001_init.sql
```

## Status

Builds clean, typechecks clean, lints clean. The `mock` path is verified
end to end. The `fal` and `kling` adapters are written against their published
API contracts but have not been run against live credentials.
"# mic-studio" 
