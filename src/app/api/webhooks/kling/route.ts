import { NextResponse } from "next/server";
import { applyTaskUpdate } from "@/lib/generations";
import { klingPayloadToTask, type KlingTaskData } from "@/lib/providers/kling";

export const runtime = "nodejs";

/**
 * Official Kling webhook. Set PROVIDER_CALLBACK_URL to
 *   https://your-domain/api/webhooks/kling?token=<PROVIDER_CALLBACK_SECRET>
 *
 * The platform does not sign its callbacks, so the shared secret in the query
 * string is the guard. The payload is treated as a hint only: we take the
 * task_id from it and trust the row lookup, and applyTaskUpdate refuses to
 * move a job out of a terminal state.
 */
export async function POST(req: Request) {
  const expected = process.env.PROVIDER_CALLBACK_SECRET;
  if (expected) {
    const token = new URL(req.url).searchParams.get("token");
    if (token !== expected) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  let payload: KlingTaskData | { data?: KlingTaskData };
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad payload" }, { status: 400 });
  }

  const data =
    "task_id" in payload ? payload : (payload as { data?: KlingTaskData }).data;

  if (!data?.task_id) {
    return NextResponse.json({ error: "Missing task_id" }, { status: 400 });
  }

  try {
    await applyTaskUpdate(data.task_id, klingPayloadToTask(data));
  } catch (e) {
    console.error("[webhook/kling] failed", e);
    // 500 so Kling retries.
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
