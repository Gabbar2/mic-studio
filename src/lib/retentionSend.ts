/**
 * Transactional send for retention notices — one email, one recipient, HTML
 * built by retentionEmailTemplates.ts rather than a Resend dashboard
 * template (see that file's doc comment for why).
 *
 * Same Resend HTTP endpoint and RESEND_API_KEY as alerts.ts and events.ts,
 * but its own `from` address (RETENTION_FROM) — an operator alert and a
 * customer-facing "your media is being deleted" notice should never look
 * like they came from the same mailbox, so a reply lands somewhere a human
 * actually reads it.
 */

const RESEND_SEND_ENDPOINT = "https://api.resend.com/emails";

function config() {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return null;
  const from = process.env.RETENTION_FROM ?? "notices@micstudio.app";
  return { apiKey, from };
}

export function retentionSendConfigured(): boolean {
  return config() !== null;
}

export async function sendRetentionEmail(opts: {
  to: string;
  subject: string;
  html: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const c = config();
  if (!c) return { ok: false, error: "RESEND_API_KEY is not set" };

  try {
    const res = await fetch(RESEND_SEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${c.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `Mic Studio <${c.from}>`,
        to: [opts.to],
        subject: opts.subject,
        html: opts.html,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error("[retention] resend refused", res.status, body);
      return { ok: false, error: `Resend ${res.status}: ${body.slice(0, 300)}` };
    }
    return { ok: true };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error("[retention] send failed", error);
    return { ok: false, error };
  }
}
