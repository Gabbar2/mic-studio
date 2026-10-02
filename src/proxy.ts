import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Next 16 renamed the `middleware` convention to `proxy`. Same runtime, same
// matcher semantics.
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // Refreshes the auth token cookie. The result is deliberately unused — this
  // call exists for its side effect, and /studio no longer gates on a session.
  await supabase.auth.getUser();

  // /studio is deliberately open. A visitor gets to see the thing and make one
  // clip before being asked for anything — the sign-in wall used to sit in
  // front of any value at all, which is where most people left.
  //
  // No anonymous account is created here. That happens only when someone
  // presses Generate, so a crawler hitting this page never becomes a row in
  // auth.users.

  return response;
}

export const config = {
  matcher: [
    // everything except static assets and the Kling webhook
    "/((?!_next/static|_next/image|favicon.ico|api/webhooks|.*\\.(?:svg|png|jpg|jpeg|gif|webp|mp4)$).*)",
  ],
};
