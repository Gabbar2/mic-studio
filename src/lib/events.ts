/**
 * Custom events sent to Resend, to drive dashboard Automations (e.g. the
 * "first_login" welcome-credit email).
 *
 * Same pattern as alerts.ts: a plain fetch against Resend's HTTP API, silent
 * no-op when unconfigured, never throws into the caller's request. A signup
 * flow must not fail — or even slow down — because a marketing email failed
 * to queue.
 *
 * NOTE: this hits /events/send, the endpoint that fires one occurrence of an
 * event for a specific contact. That is a different endpoint from POST
 * /events, which only *defines* an event's name/schema (what the dashboard's
 * "Add event" dialog calls) and does not deliver anything on its own.
 */

const RESEND_EVENTS_ENDPOINT = "https://api.resend.com/events/send";

function apiKey(): string | null {
  return process.env.RESEND_API_KEY ?? null;
}

export function eventsConfigured(): boolean {
  return apiKey() !== null;
}

/**
 * Fires a named custom event to Resend so a dashboard Automation with a
 * matching "Custom event" trigger can act on it (e.g. send a template email).
 *
 * `email` identifies the contact the event belongs to; `payload` is whatever
 * the automation's template variables need (kept to strings/numbers/booleans
 * — Resend events don't need anything richer than that). Inside the template,
 * these show up under the `event.*` namespace, e.g. `event.first_name`.
 */
export async function fireResendEvent(
  event: string,
  email: string,
  payload: Record<string, string | number | boolean> = {},
): Promise<boolean> {
  const key = apiKey();
  if (!key || !email) return false;

  try {
    const res = await fetch(RESEND_EVENTS_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ event, email, payload }),
    });
    if (!res.ok) {
      console.error(
        "[events] resend refused",
        event,
        res.status,
        await res.text(),
      );
      return false;
    }
    return true;
  } catch (e) {
    console.error("[events] send failed", event, e);
    return false;
  }
}
