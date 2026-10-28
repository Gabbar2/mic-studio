import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/admin";
import {
  isMockElementEditEnabled,
  setMockElementEditEnabled,
} from "@/lib/elementEditSettings";

/**
 * Reads and flips the per-element AI edit's mock/real switch — the toggle
 * on /admin that ElementEditSettingsPanel.tsx renders. Admin-gated the same
 * way as every other /api/admin/* route in this app (see lib/admin.ts):
 * never trust anything the browser claims, check profiles.is_admin via the
 * service-role client on every request.
 */

export async function GET() {
  const gate = await requireAdminApi();
  if (!gate.ok) return gate.response;

  const mock = await isMockElementEditEnabled();
  return NextResponse.json({ mock });
}

export async function POST(req: Request) {
  const gate = await requireAdminApi();
  if (!gate.ok) return gate.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Expected JSON" }, { status: 400 });
  }

  const { mock } = (body ?? {}) as { mock?: unknown };
  if (typeof mock !== "boolean") {
    return NextResponse.json(
      { error: "Expected { mock: boolean }" },
      { status: 400 },
    );
  }

  await setMockElementEditEnabled(mock);
  return NextResponse.json({ mock });
}
