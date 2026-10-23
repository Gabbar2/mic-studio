/**
 * The 2-3 selectable "looks" for a retention-notice email — the admin picks
 * one from /admin, not from Resend's own dashboard. Resend does offer a
 * dashboard Templates feature with its own variable substitution, but its
 * variables are flat key/value pairs with no documented support for an
 * array of links that varies in length per recipient (one clip vs a dozen).
 * Building the HTML here instead, with plain server-side substitution, means
 * every account's actual clip list renders correctly regardless of count,
 * and the templates stay reviewable and versioned in this repo like
 * everything else — same tradeoff reasoning as UpgradePrompt.tsx building
 * its own pricing table rather than reaching for an external one.
 */

export interface RetentionClipLink {
  url: string;
  createdAt: string;
}

export interface RetentionEmailParams {
  email: string;
  deadline: string; // "YYYY-MM-DD"
  clipLinks: RetentionClipLink[];
}

export interface RetentionTemplate {
  key: string;
  /** Shown on the admin picker. */
  label: string;
  description: string;
  build: (params: RetentionEmailParams) => { subject: string; html: string };
}

/** Minimal escaping — this HTML goes into an email client, not a browser DOM,
 * but the email address and clip URLs both ultimately come from data a user
 * once supplied (sign-up email, prompt-derived filenames), so it is escaped
 * the same way any other user-sourced string going into markup would be. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDeadline(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/** The <ul> of clip links shared by every template. Falls back to a plain
 * sentence when the account has nothing stored — sending a bulk notice to
 * every account (rather than only ones with clips) was a deliberate choice,
 * so this has to read sensibly for a zero-clip recipient too. */
function clipListHtml(clipLinks: RetentionClipLink[]): string {
  if (clipLinks.length === 0) {
    return `<p style="margin:0 0 16px;color:#9aa0a6;font-size:14px;">
      No clips are currently stored on this account.
    </p>`;
  }
  const items = clipLinks
    .map((c) => {
      const date = new Date(c.createdAt).toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
      return `<li style="margin:0 0 8px;">
        <a href="${esc(c.url)}" style="color:#a4d418;text-decoration:underline;">
          Download clip — ${esc(date)}
        </a>
      </li>`;
    })
    .join("");
  return `<ul style="margin:0 0 16px;padding-left:20px;">${items}</ul>`;
}

function shell(opts: {
  preheader: string;
  bodyHtml: string;
}): string {
  // One shared wrapper (dark card, same accent green as the app) so the
  // three templates differ only in tone/copy, not in whether they look like
  // they came from Mic Studio.
  return `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#0a0a0a;font-family:-apple-system,Segoe UI,Roboto,sans-serif;">
    <span style="display:none;max-height:0;overflow:hidden;">${esc(opts.preheader)}</span>
    <div style="max-width:480px;margin:0 auto;background:#141414;border:1px solid #2a2a2a;border-radius:12px;padding:28px;">
      <div style="color:#a4d418;font-weight:600;font-size:14px;letter-spacing:0.02em;margin-bottom:16px;">
        MIC STUDIO
      </div>
      ${opts.bodyHtml}
      <p style="margin:24px 0 0;color:#6b6f76;font-size:11px;line-height:1.6;">
        You're receiving this because you have an account at micstudio.app.
        Questions? Reply to this email.
      </p>
    </div>
  </body>
</html>`;
}

const friendly: RetentionTemplate = {
  key: "friendly",
  label: "Friendly reminder",
  description: "Warm, low-pressure heads-up with plenty of notice.",
  build: ({ email, deadline, clipLinks }) => ({
    subject: "A quick heads-up about your Mic Studio clips",
    html: shell({
      preheader: `Download your clips before ${formatDeadline(deadline)}`,
      bodyHtml: `
        <h1 style="margin:0 0 12px;color:#fff;font-size:18px;">Just a heads-up</h1>
        <p style="margin:0 0 16px;color:#d6d8db;font-size:14px;line-height:1.6;">
          Hi, this is a friendly reminder about the account signed up as
          ${esc(email)}. We're doing some housekeeping on older clips, and
          yours are scheduled to be cleared out on
          <strong style="color:#fff;">${esc(formatDeadline(deadline))}</strong>.
        </p>
        <p style="margin:0 0 12px;color:#d6d8db;font-size:14px;line-height:1.6;">
          No rush, but if there's anything below you'd like to keep, grab it
          before then:
        </p>
        ${clipListHtml(clipLinks)}
        <p style="margin:0;color:#9aa0a6;font-size:13px;line-height:1.6;">
          After that date, this media is permanently removed from our
          servers and can't be recovered.
        </p>
      `,
    }),
  }),
};

const firm: RetentionTemplate = {
  key: "firm",
  label: "Standard notice",
  description: "Clear and direct — the default tone for most campaigns.",
  build: ({ email, deadline, clipLinks }) => ({
    subject: `Action needed: your Mic Studio clips are scheduled for deletion`,
    html: shell({
      preheader: `Download before ${formatDeadline(deadline)} or your media is deleted`,
      bodyHtml: `
        <h1 style="margin:0 0 12px;color:#fff;font-size:18px;">
          Please download your media
        </h1>
        <p style="margin:0 0 16px;color:#d6d8db;font-size:14px;line-height:1.6;">
          The account ${esc(email)} has clips stored on Mic Studio that are
          scheduled for deletion on
          <strong style="color:#fff;">${esc(formatDeadline(deadline))}</strong>.
        </p>
        <p style="margin:0 0 12px;color:#d6d8db;font-size:14px;line-height:1.6;">
          Please download anything you want to keep before that date:
        </p>
        ${clipListHtml(clipLinks)}
        <p style="margin:0;color:#e8a33d;font-size:13px;line-height:1.6;font-weight:600;">
          After ${esc(formatDeadline(deadline))}, this media will be
          permanently deleted from our servers and cannot be recovered.
        </p>
      `,
    }),
  }),
};

const final: RetentionTemplate = {
  key: "final",
  label: "Final notice",
  description: "Urgent tone for a last call before the deadline.",
  build: ({ email, deadline, clipLinks }) => ({
    subject: `Final notice: your Mic Studio clips are deleted on ${formatDeadline(
      deadline,
    )}`,
    html: shell({
      preheader: `Last chance — download before ${formatDeadline(deadline)}`,
      bodyHtml: `
        <h1 style="margin:0 0 12px;color:#ff6b6b;font-size:18px;">
          Final notice
        </h1>
        <p style="margin:0 0 16px;color:#d6d8db;font-size:14px;line-height:1.6;">
          This is the last reminder for the account ${esc(email)}. Clips
          still stored on this account will be
          <strong style="color:#ff6b6b;">permanently deleted</strong> on
          <strong style="color:#fff;">${esc(formatDeadline(deadline))}</strong>
          — there will not be another notice before then.
        </p>
        <p style="margin:0 0 12px;color:#d6d8db;font-size:14px;line-height:1.6;">
          Download anything you need now:
        </p>
        ${clipListHtml(clipLinks)}
        <p style="margin:0;color:#ff6b6b;font-size:13px;line-height:1.6;font-weight:600;">
          Once deleted, this media cannot be recovered by us or by you.
        </p>
      `,
    }),
  }),
};

export const RETENTION_TEMPLATES: RetentionTemplate[] = [friendly, firm, final];

export function retentionTemplate(key: string): RetentionTemplate | undefined {
  return RETENTION_TEMPLATES.find((t) => t.key === key);
}
