import Link from "next/link";
import { requireAdmin } from "@/lib/admin";
import { usd } from "@/lib/format";
import { creditLabel } from "@/lib/pricing";
import { QUALITY_LABEL } from "@/lib/models";
import type { Generation } from "@/lib/types";

export const dynamic = "force-dynamic";

function fmt(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const STATUS_CLASS: Record<Generation["status"], string> = {
  succeeded: "text-accent-400",
  failed: "text-rose-400",
  processing: "text-ink-300",
  queued: "text-ink-400",
};

/** A small clickable image thumbnail for one input attachment. */
function Thumb({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={label}
      className="block h-10 w-10 shrink-0 overflow-hidden rounded border border-ink-700 transition hover:border-accent-400"
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- admin-only
          thumbnail for arbitrary storage URLs; not worth Next/Image's
          remote-pattern config for a read-only internal report. */}
      <img
        src={href}
        alt={label}
        className="h-full w-full object-cover"
        loading="lazy"
      />
    </a>
  );
}

/**
 * One user's full generation history — every clip they've made, whatever it
 * cost, and whether it succeeded. Read-only on purpose: this is for looking,
 * not acting. There's deliberately no reuse/upscale/retry here the way the
 * studio's own gallery has — those spend the *viewing* account's credits,
 * and an admin browsing someone else's history should never accidentally
 * charge themselves for it.
 *
 * Clip links open the same public storage URL described in the file's own
 * `video_url` — no signed URL step, because none exists yet in this app; see
 * the earlier note about that bucket being public.
 */
export default async function AdminUserGenerationsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { admin } = await requireAdmin();

  const [{ data: profile }, { data: generations }, authUser] =
    await Promise.all([
      admin
        .from("profiles")
        .select("email, display_name")
        .eq("id", id)
        .maybeSingle(),
      admin
        .from("generations")
        .select("*")
        .eq("user_id", id)
        .order("created_at", { ascending: false }),
      // Same fallback the users list already applies: `profiles.email` can
      // be blank for an account that started as an anonymous trial session,
      // even once it's a real, confirmed signup — auth.users always has the
      // real email. Without this, this page showed "Unknown user" for an
      // account the list page displayed correctly one click earlier.
      admin.auth.admin.getUserById(id),
    ]);

  const rows = (generations ?? []) as Generation[];
  const displayEmail = profile?.email ?? authUser.data.user?.email ?? null;

  return (
    <main className="min-h-screen bg-ink-950 px-4 py-8 sm:px-8">
      <div className="mx-auto max-w-5xl">
        <Link
          href="/admin"
          className="text-xs text-ink-400 transition hover:text-accent-400"
        >
          ← Users
        </Link>

        <div className="mt-4 flex items-baseline justify-between gap-4">
          <h1 className="text-2xl font-semibold tracking-tight text-white">
            {displayEmail ?? profile?.display_name ?? "Unknown user"}
          </h1>
          <span className="text-xs tabular-nums text-ink-400">
            {rows.length} generations
          </span>
        </div>

        {rows.length === 0 ? (
          <p className="mt-8 text-sm text-ink-400">
            This account has never generated a clip.
          </p>
        ) : (
          <div className="mt-6 overflow-x-auto rounded-xl border border-ink-800">
            <table className="w-full min-w-[1250px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-ink-800 bg-ink-900/60">
                  <th className="px-3 py-2.5 text-left text-[11px] font-medium uppercase tracking-wide text-ink-400">
                    Created
                  </th>
                  <th className="px-3 py-2.5 text-left text-[11px] font-medium uppercase tracking-wide text-ink-400">
                    Prompt
                  </th>
                  <th className="px-3 py-2.5 text-left text-[11px] font-medium uppercase tracking-wide text-ink-400">
                    Mode
                  </th>
                  <th className="px-3 py-2.5 text-left text-[11px] font-medium uppercase tracking-wide text-ink-400">
                    Quality
                  </th>
                  <th className="px-3 py-2.5 text-right text-[11px] font-medium uppercase tracking-wide text-ink-400">
                    Duration
                  </th>
                  <th className="px-3 py-2.5 text-left text-[11px] font-medium uppercase tracking-wide text-ink-400">
                    Status
                  </th>
                  <th className="px-3 py-2.5 text-right text-[11px] font-medium uppercase tracking-wide text-ink-400">
                    Credits Charged
                  </th>
                  <th className="px-3 py-2.5 text-right text-[11px] font-medium uppercase tracking-wide text-ink-400">
                    Cost / Charged
                  </th>
                  <th className="px-3 py-2.5 text-right text-[11px] font-medium uppercase tracking-wide text-ink-400">
                    Profit
                  </th>
                  <th className="px-3 py-2.5 text-left text-[11px] font-medium uppercase tracking-wide text-ink-400">
                    Inputs
                  </th>
                  <th className="px-3 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {rows.map((g) => (
                  <tr
                    key={g.id}
                    className="border-b border-ink-800/70 last:border-0 hover:bg-ink-900/40"
                  >
                    <td className="whitespace-nowrap px-3 py-2.5 text-ink-400">
                      {fmt(g.created_at)}
                    </td>
                    {/* Full prompt, wrapped rather than truncated — an admin
                        reading this report needs the whole thing, not a
                        hover-only tooltip that mobile and copy/paste can't
                        reach. */}
                    <td className="max-w-[360px] min-w-[220px] whitespace-pre-wrap px-3 py-2.5 align-top text-ink-200">
                      {g.prompt}
                    </td>
                    <td className="px-3 py-2.5 text-ink-300">{g.mode}</td>
                    <td className="px-3 py-2.5 text-ink-300">
                      {QUALITY_LABEL[g.quality] ?? g.quality}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-ink-300">
                      {g.duration_seconds}s
                    </td>
                    <td
                      className={`px-3 py-2.5 font-medium ${STATUS_CLASS[g.status]}`}
                    >
                      {g.status}
                      {g.status === "failed" && g.error_message && (
                        <span
                          className="ml-1.5 cursor-help text-ink-500"
                          title={g.error_message}
                        >
                          (why?)
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums text-ink-200">
                      {creditLabel(g.charged_cents)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums text-ink-400">
                      {usd(g.cost_cents)} / {usd(g.charged_cents)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums text-ink-400">
                      {/* A failed job is refunded in full and never billed by
                          the provider — the row still holds its estimated
                          cost/charge for the record, but no margin was ever
                          realized, so it reads as "—" rather than a number
                          that implies money that was never actually kept. A
                          queued/processing job has not settled yet either. */}
                      {g.status === "succeeded" ? (
                        <>
                          {usd((g.charged_cents ?? 0) - (g.cost_cents ?? 0))}
                          {g.charged_cents ? (
                            <span className="ml-1 text-ink-600">
                              (
                              {Math.round(
                                (((g.charged_cents ?? 0) -
                                  (g.cost_cents ?? 0)) /
                                  g.charged_cents) *
                                  100,
                              )}
                              %)
                            </span>
                          ) : null}
                        </>
                      ) : (
                        <span className="text-ink-600">—</span>
                      )}
                    </td>
                    {/* What was fed in, not just what came out — a start
                        frame, an end frame, a reference video and up to four
                        reference images can each be attached depending on
                        mode. Thumbnails for images (click through to the
                        original), a plain link for video since a muted
                        autoplay thumbnail isn't worth the complexity here. */}
                    <td className="px-3 py-2.5 align-top">
                      {g.source_image_url ||
                      g.end_image_url ||
                      g.reference_video_url ||
                      g.reference_image_urls.length ? (
                        <div className="flex flex-wrap items-center gap-1.5">
                          {g.source_image_url && (
                            <Thumb
                              href={g.source_image_url}
                              label="Start frame"
                            />
                          )}
                          {g.end_image_url && (
                            <Thumb href={g.end_image_url} label="End frame" />
                          )}
                          {g.reference_video_url && (
                            <a
                              href={g.reference_video_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="rounded border border-ink-700 px-1.5 py-1 text-[11px] text-accent-400 underline underline-offset-2 transition hover:text-white"
                            >
                              Ref video
                            </a>
                          )}
                          {g.reference_image_urls.map((url, i) => (
                            <Thumb
                              key={url}
                              href={url}
                              label={`Ref image ${i + 1}`}
                            />
                          ))}
                        </div>
                      ) : (
                        <span className="text-xs text-ink-600">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      {g.video_url ? (
                        <a
                          href={g.video_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-accent-400 underline underline-offset-2 transition hover:text-white"
                        >
                          Watch
                        </a>
                      ) : (
                        <span className="text-xs text-ink-600">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}
