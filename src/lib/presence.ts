/**
 * Live visitor presence and chat — shared constants.
 *
 * No Supabase Realtime: presence and messages are both read through short
 * polls against the Next.js server (see lib/supabase/admin.ts's own
 * reasoning for why every write goes through the service-role client), the
 * same pattern already used for generation status and provider balance
 * elsewhere in this app. That means nothing new to configure in the
 * Supabase dashboard beyond the migration, at the cost of "real-time"
 * meaning "within a few seconds" rather than sub-second push — fine for a
 * support chat, not fine for a cursor-tracking app.
 */

/** A visitor counts as online if they've pinged within this many seconds. */
export const ONLINE_WINDOW_SECONDS = 30;

/** How often the widget sends a heartbeat, once a session exists. */
export const PRESENCE_PING_MS = 20_000;

/** How often an open chat thread (visitor widget or admin panel) polls for new messages. */
export const CHAT_POLL_MS = 4_000;

/** How often the admin live list polls for who's online. */
export const PRESENCE_POLL_MS = 6_000;

/** How often the closed widget polls just to refresh its unread badge. */
export const UNREAD_POLL_MS = 20_000;

export type VisitorTier = "trial" | "free" | "unlocked";

export interface LiveVisitor {
  userId: string;
  email: string | null;
  tier: VisitorTier;
  path: string | null;
  lastSeenAt: string;
  unreadCount: number;
}

export interface ChatMessageRow {
  id: string;
  sender: "visitor" | "admin";
  body: string;
  created_at: string;
}
