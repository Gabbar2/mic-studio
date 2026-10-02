import { NextResponse } from "next/server";
import { applyTaskUpdate } from "@/lib/generations";
import type { ProviderTask } from "@/lib/providers";

export const runtime = "nodejs";

interface FalWebhookBody {
  request_id?: string;
  status?: string;
  error?: string;
  payload?: { video?: { url?: string } };
}

/**
 * fal webhook. fal appends the target as a query param on submit, so the URL
 * we register is PROVIDER_CALLBACK_URL:
 *   https://your-domain/api/webhooks/fal?token=<PROVIDER_CALLBACK_SECRET>
 *
 * fal may retry deliveries, so this must be idempotent — applyTaskUpdate is.
 */
export async function POST(req: Request) {
  const expected = process.env.PROVIDER_CALLBACK_SECRET;
  if (expected) {
    const token = new URL(req.url).searchParams.get("token");
    if (token !== expected) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  let body: FalWebhookBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad payload" }, { status: 400 });
  }

  if (!body.request_id) {
    return NextResponse.json({ error: "Missing request_id" }, { status: 400 });
  }

  const url = body.payload?.video?.url;
  const ok = body.status === "OK" && !!url;

  const task: ProviderTask = ok
    ? { taskId: body.request_id, status: "succeeded", videoUrl: url }
    : {
        taskId: body.request_id,
        status: "failed",
        error: body.error ?? "Generation failed at fal",
      };

  try {
    await applyTaskUpdate(body.request_id, task);
  } catch (e) {
    console.error("[webhook/fal] failed", e);
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
