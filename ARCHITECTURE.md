# Mic Studio — architecture & setup

A Leonardo-style generation studio with exactly one model behind it: **Kling 3.0**.
It can be driven through fal.ai or the official Kuaishou Open Platform — one env
var picks which. Everything is structured so that adding model #2 is a config
change, not a rewrite.

---

## 1. The one decision that matters

Video generation is **asynchronous and slow** (30s–3min per clip). That single
fact drives the whole design. You cannot generate inside an HTTP request — the
request will time out, and on Vercel it will be killed at 60s regardless.

So the flow is split into three independent pieces:

```
 ┌──────────┐  POST /api/generate   ┌─────────────┐   provider.create()
 │ Browser  │ ────────────────────► │  Next.js    │ ─────────────────────────────►  fal.ai
 │          │ ◄──────────────────── │  route      │ ◄── { taskId }                  or Kling
 └────┬─────┘   201 { generation }  └──────┬──────┘                                     │
      │                                    │ INSERT status='processing'                 │
      │                                    ▼                                            │
      │                             ┌─────────────┐                                     │
      │  GET /api/generations       │  Postgres   │ ◄───────────────────────────────────┘
      │  (poll, 5s, only while      │  (Supabase) │   POST /api/webhooks/{provider}
      └────────────────────────────►│             │   when the render finishes
         a job is in flight         └─────────────┘
```

Three things reconcile state, in order of preference:

1. **Webhook** (`/api/webhooks/fal`, `/api/webhooks/kling`) — the provider calls
   you the moment a job lands.
   Fastest, zero polling cost. Needs a public URL, so it does nothing in local dev.
2. **Read-through poll** (`/api/generations`) — before returning the gallery, the
   route refreshes any in-flight job straight from its provider. This is what makes the
   app work correctly on `localhost`, and it's the reason you don't need a queue
   worker to ship.
3. **Cron sweep** (`/api/cron/poll`) — catches jobs whose webhook was lost during
   a deploy, and fails out anything stuck past 30 minutes. Scheduled daily,
   because Vercel's Hobby plan rejects any cron that runs more than once a day;
   on Pro you can drop this to `*/5 * * * *`.

All three funnel into one function, `applyTaskUpdate()`, which is idempotent and
refuses to move a row backwards out of a terminal state. Late and duplicate
webhooks are therefore harmless.

---

## 2. Stack

| Layer | Choice | Why |
|---|---|---|
| Framework | Next.js 16, App Router, TypeScript | Server routes and UI in one deploy |
| Styling | Tailwind v4 | Theme tokens live in `globals.css`, no config file |
| Auth | Supabase Auth (magic link + Google) | No password storage, no reset flow to build |
| Database | Supabase Postgres + RLS | Row-level security means a bug in a query can't leak another user's gallery |
| Storage | Supabase Storage | See §4 — you must keep your own copy of the video |
| Hosting | Vercel | Cron is one JSON file; the webhook is just a route |
| Provider | fal.ai or Kling Open Platform | Swappable behind one interface — see §2b |

### 2b. The provider layer

`src/lib/providers/` holds one adapter per service, all satisfying the same
`VideoProvider` interface: `create(params)` and `get(taskId)`, both returning a
normalised `ProviderTask`. Nothing downstream ever sees a provider's native
envelope, which is what keeps adding a third service a contained change.

| `PROVIDER=` | Auth | Notes |
|---|---|---|
| `fal` | one static `FAL_KEY` | Instant signup, pay-as-you-go. Fastest to real output. |
| `kling` | AccessKey/SecretKey → signed JWT | Official Kuaishou. Best pricing, needs a verified business account. |
| `mock` | none | Placeholder clips from `public/mock`, no network. For UI work. |

Two details make switching safe mid-flight:

- The `provider` column on `generations` records which service created each
  job, and polling routes through `providerFor(row.provider, row.task_id)` — so
  changing `PROVIDER` never orphans in-flight jobs.
- Mock jobs are matched by task-id prefix rather than by the env var, so they
  keep resolving after you switch to a real provider.

**Why not a job queue (BullMQ/Inngest/QStash)?** The provider already *is* the queue.
It gives you a task ID and calls you back. Adding your own queue would only
duplicate that. If you later fan out to several providers with wildly different
semantics, revisit this — but not before.

---

## 3. Data model

Two tables. `profiles` (one per auth user, auto-created by a trigger) and
`generations` (one row per clip).

The important bits of `generations`:

- **`provider` + `provider_task_id`**, uniquely indexed together. Adding a second
  provider later means new row values, not a new table.
- **No INSERT/UPDATE RLS policy for users.** Reads are RLS-protected to
  `auth.uid() = user_id`; every write goes through the service-role key on the
  server. A user physically cannot forge a job row that claims work they didn't
  request. This matters more once billing exists.
- **`cost_cents`** is stamped at submit time from the model's price table, so you
  can answer "what did last month cost me" without reconciling provider invoices.

Free-tier throttle: `profiles.daily_quota` (default 5) checked against the
`generations_today()` SQL function. Failed jobs don't count against it.

---

## 4. The thing that will bite you: expiring URLs

Provider CDN links expire — roughly 30 days for Kling, shorter on fal. A gallery
that stores only the provider's URL looks fine for a while and then quietly turns
into a wall of broken players, and by then the source clips are gone for good.
(This is not hypothetical: the sample-video bucket originally used by the mock
provider went private mid-build and every mock job started returning
AccessDenied XML.)

`applyTaskUpdate()` therefore fires off `mirrorToStorage()`: it downloads the
finished MP4, uploads it to the `generations` Supabase bucket, and rewrites
`video_url` to point at your own copy. It's fire-and-forget — a mirror failure
never fails the job — and `storage_path` records whether it succeeded.

Budget for this properly. Kling 3.0 returns **1080x1920 at ~24 Mbps**, which is
**~29 MB for a 10-second clip** — not the 2–5 MB a 720p render would be.
Supabase's free tier gives 1 GB of file storage, so that is roughly **35 clips**
before you are full, and 5 GB of monthly egress, roughly 170 video views.

A 25-scene project at 3–5 attempts per scene produces 2–4 GB. Either add a
storage lifecycle (keep-flag plus a sweep for the rest) or move to Supabase Pro
at $25/month, which raises the ceiling to 100 GB. See PLANS.md.

---

## 5. Setup

**1 — Supabase.** Create a project. Open the SQL editor, paste
`supabase/migrations/0001_init.sql`, run it. Under Authentication → Providers,
enable Email; enable Google too if you want the OAuth button. Add
`http://localhost:3000/auth/callback` and your production equivalent to the
redirect allow-list.

**2 — Pick a provider.**

*fal (fastest):* sign up at <https://fal.ai>, create a key at
<https://fal.ai/dashboard/keys>, set `PROVIDER=fal` and `FAL_KEY=...`. Billing is
pay-as-you-go with no verification step.

*Official Kling:* register at <https://app.klingai.com> and go to API Management.
The platform issues an **AccessKey / SecretKey pair**, not a static API key —
`src/lib/providers/kling.ts` mints a short-lived HS256 JWT from them on every
call (`iss` = access key, 30-minute `exp`, 5-second `nbf` for clock skew). Set
`PROVIDER=kling`. International accounts use `https://api-singapore.klingai.com`;
mainland accounts use `https://api.klingai.com`.

> **Verify the model string.** Kuaishou has changed its naming between releases
> (`kling-v1-6`, `kling-v2-master`, `kling-v2-5-turbo-pro`…). `KLING_MODEL_NAME`
> defaults to `kling-v3-0`; check the exact value in your console's model list
> and override the env var if it differs. Only the `kling` adapter cares.

*Neither yet:* `PROVIDER=mock` runs the entire pipeline — queue, poll, storage
mirror, gallery — against placeholder clips in `public/mock`, with no
credentials and no network.

**3 — Run it.**

```bash
cp .env.example .env.local   # fill in the six required values
npm install
npm run dev
```

Leave `PROVIDER_CALLBACK_URL` blank locally. The read-through poll covers you.

**4 — Deploy.** Push to Vercel, set the same env vars, then set
`PROVIDER_CALLBACK_URL` to
`https://your-domain/api/webhooks/<fal|kling>?token=<PROVIDER_CALLBACK_SECRET>`.
fal picks it up per-request; Kling needs it registered in the console. `vercel.json` wires the cron sweep.

---

## 6. Cost model

Kling 3.0, per the current public rate card:

| Tier | Per 5s | Per 10s |
|---|---|---|
| Standard | ~$0.42 | ~$0.84 |
| Pro / Turbo (native audio) | ~$0.56 | ~$1.12 |

At the default 5 free generations/user/day, **100 daily active users on Standard
5s costs about $210/day**. That is the number to watch. Concretely: keep the
quota low, ship billing before you ship marketing, and don't run a public
unauthenticated demo.

Fixed costs are near zero to start — Vercel Hobby and Supabase Free cover a
prototype, and the first real bill will be Supabase storage, not compute.

---

## 7. What's deliberately not here

- **Billing.** You said free for now. The schema is ready for it: add a
  `credit_ledger` table (append-only, `+` on purchase, `−` on generation),
  deduct inside the same transaction as the `generations` insert, and swap the
  daily-quota check in `/api/generate` for a balance check. Stripe Checkout +
  one webhook is the rest.
- **Image upload.** Image-to-video currently takes a URL. Wire Supabase Storage
  with a signed upload URL and pass the public URL through — the API route
  already accepts it.
- **Rate limiting beyond the daily quota.** Add Upstash Ratelimit on
  `/api/generate` before you launch publicly; the daily quota is a DB round-trip,
  not a defence against a burst.
- **Video thumbnails.** `thumbnail_url` exists but is never populated. Cheapest
  fix is `poster` frames extracted with ffmpeg in the mirror step.

## 8. Adding model #2

1. Add a `ModelDef` to `src/lib/models.ts`.
2. If it needs a different service, add `src/lib/providers/<name>.ts`
   implementing `VideoProvider`, and register it in `providers/index.ts`.
3. That's it — `/api/generate`, the pollers and the webhooks all route through
   the interface.

The UI needs no changes — `Composer` already renders whatever `MODELS` contains,
including per-model duration, ratio, quality and audio capabilities.
