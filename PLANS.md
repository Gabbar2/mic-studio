# What you're actually on — plans, limits, and what breaks first

Four separate systems, four separate meters. None of them talk to each other.

---

## 1. fal.ai — where the money goes

**Model: prepaid credit. No subscription, no monthly fee, no free allowance.**

You top up a balance, generations draw it down, and when it hits zero everything
stops until you top up again. That's the whole system. There is no plan to
upgrade or downgrade, and nothing recurring to cancel.

Two details worth knowing:

- **You're only charged for successful outputs.** fal doesn't bill for server
  errors or for time spent waiting in the queue. This is why your app's spend
  total deliberately excludes failed jobs — it matches how fal actually bills.
- **A zero balance is a hard stop, not an overdraft.** You saw this already:
  *"User is locked. Reason: Exhausted balance."* Nothing queues up waiting; the
  request is simply rejected.

### Your rates (Kling 3.0)

| Tier | Silent | With native audio |
|---|---|---|
| Standard | $0.084/s | $0.126/s |
| Pro | $0.112/s | $0.168/s |

A 10s Pro clip with audio — your current default — is **$1.68**. At $19.96
remaining, that's about **11 more generations**.

---

## 2. Supabase — where the files go

**You're on the Free plan.** It costs nothing and it is genuinely usable, but
three of its limits matter to a video app specifically.

| Limit | Free | What it means for you |
|---|---|---|
| File storage | **1 GB** | ~35 of your clips |
| Egress / month | **5 GB** | ~170 video views |
| Database | 500 MB | Thousands of rows — not your constraint |
| Inactivity | **paused after 1 week** | App stops working until you unpause |

### The one that will bite you first: storage

Your clips are **~29 MB each** — 1080×1920 at 24 Mbps is a big file. Every
successful generation gets mirrored into your Supabase bucket, so:

**1 GB ÷ 29 MB ≈ 35 clips before you're full.**

Your 25-scene project, at 3–5 attempts per scene, produces 75–125 successful
clips. That's **2.2–3.6 GB** — three times over the limit before you've finished
the video.

(An earlier version of ARCHITECTURE.md estimated ~250 clips. That assumed 2–5 MB
files at 720p. Your actual output is six times larger. The correction matters.)

**Three ways out, cheapest first:**

1. **Download and delete as you go.** Pull the keepers to your disk, delete the
   rejects from Supabase Storage. Free, but manual.
2. **Stop mirroring, accept expiry.** Keep only fal's URLs. Free, but the links
   expire and the clips are gone for good — this is exactly the failure mode the
   mirror exists to prevent.
3. **Supabase Pro, $25/month.** 100 GB storage and 250 GB egress. That's ~3,400
   clips. For a project of this size it's the honest answer.

### The one that will surprise you: the 1-week pause

Free projects are **paused after 7 days of inactivity**. If you don't touch this
for a week, the database goes to sleep and the app stops working until you log
into the Supabase dashboard and restore it. Nothing is lost — but it will look
broken, and it always happens at the worst moment.

### Egress is why the poster-frame change mattered

Before that change, every gallery load streamed live video for every tile. At
29 MB a clip, **five page loads with ten clips visible would have consumed your
entire monthly egress.** Now a tile is a ~40 KB JPEG and video only loads on
hover, which is roughly a 700× reduction on the common path. That change bought
you the free tier's viability, not just smoother playback.

---

## 3. The app's own limits — mine, not anyone's plan

These are things I built. They're configurable and they aren't billing.

**`daily_quota` — default 5 per user per day.** Purely a safety valve. At $1.68
a clip, a stuck retry loop could drain your balance in seconds; five a day caps
that. Resets at midnight UTC (4am Dubai). Failed jobs don't count.

```sql
update public.profiles set daily_quota = 200
where email = 'deliverybykea@gmail.com';
```

**`cost_cents` — stamped on every row at submit time**, computed from fal's
published per-second rates. It is what the app *believes* a job cost, not a
reading of your fal account. If fal changes pricing, this drifts.

**`spend_summary()` — sums only succeeded jobs**, matching fal's billing.

**Balance in the header** — read live from fal's billing API. Needs an
admin-scoped `FAL_KEY`; without one it silently shows nothing.

There is no user-facing credit system. Anyone who signs up gets 5 free
generations a day charged to *your* fal balance. That's fine while it's just
you, and dangerous the moment it's public.

---

## 4. Roadmap — what's built, what isn't

### Working

Auth (magic link + Google) · text-to-video · image-to-video · start & end frames
with drag-drop upload · provider layer (fal / official Kling / mock) · async job
pipeline with webhook, read-through poll and cron sweep · storage mirroring ·
poster-frame gallery · per-generation cost · spend totals · live provider balance

### Not built, roughly in the order I'd do them

1. **Storage lifecycle** — a "keep" flag, and a sweep that deletes unkept clips
   after N days. This is what makes the free tier survivable and it's small.
2. **Multi-shot storyboard** — fal exposes `multi_prompt` (up to 6 shots per
   generation). Your 8-beat prompt is currently a hint, not a shot list. This is
   the single biggest quality lever left, and it cuts retries.
3. **4K tier** — fal has a Kling v3 4K endpoint the app doesn't expose. One line
   in the adapter, meaningful jump in output quality.
4. **Rate limiting** — the daily quota is a database round-trip, not a defence
   against a burst. Upstash Ratelimit on `/api/generate` before this goes public.
5. **Billing** — Stripe Checkout, a credit ledger table, deduct in the same
   transaction as the insert. Only needed when someone other than you can sign in.
6. **Deploy** — Vercel, set the env vars, set `PROVIDER_CALLBACK_URL`, and the
   cron in `vercel.json` starts working.

### The honest summary

You have a working single-user studio. The gap between this and a product other
people pay for is items 4 and 5 — everything else is polish. The gap between
this and finishing your 25-scene video is item 1, and about $150 of fal credit.
