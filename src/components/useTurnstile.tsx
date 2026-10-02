"use client";

import { useCallback, useEffect, useRef } from "react";
import {
  TURNSTILE_ENABLED,
  TURNSTILE_SITE_KEY,
  TURNSTILE_TIMEOUT_MS,
} from "@/lib/turnstile";

/**
 * Turnstile, as a hook.
 *
 * Two things make this more than a `<script>` tag and a div.
 *
 * **A token is single-use.** Cloudflare issues one per solve, Supabase burns it
 * on verification, and reusing it fails. So every successful read resets the
 * widget to start earning the next one, which matters here because a visitor
 * signs in *and* generates, and the second call must not reuse the first
 * token.
 *
 * **A token is not ready when you want it.** The widget solves asynchronously
 * after mount. Rather than disable the button until it lands — which punishes
 * everyone for a challenge that usually takes under a second — `getToken()`
 * returns a promise that resolves the moment the token exists, and callers
 * simply await it inside their existing submit handler.
 *
 * If the key is unset, or the script is blocked, or the challenge times out,
 * `getToken()` resolves to `undefined` and the auth call proceeds without it.
 * That is the correct failure direction: with Supabase's CAPTCHA toggle off
 * the token is ignored anyway, and with it on the request is refused by
 * Supabase rather than silently succeeding. Blocking sign-in on a script that
 * an ad-blocker ate would be the worse trade.
 */

const SCRIPT_SRC =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface TurnstileApi {
  render: (
    el: HTMLElement,
    opts: {
      sitekey: string;
      callback: (token: string) => void;
      "error-callback"?: () => void;
      "expired-callback"?: () => void;
      appearance?: "always" | "execute" | "interaction-only";
      theme?: "auto" | "light" | "dark";
      size?: "normal" | "compact" | "flexible";
    },
  ) => string;
  reset: (id?: string) => void;
  remove: (id?: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptPromise: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.turnstile) return Promise.resolve();
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${SCRIPT_SRC}"]`,
    );
    const el = existing ?? document.createElement("script");
    el.src = SCRIPT_SRC;
    el.async = true;
    el.defer = true;
    el.addEventListener("load", () => resolve());
    el.addEventListener("error", () => reject(new Error("turnstile blocked")));
    if (!existing) document.head.appendChild(el);
  });

  return scriptPromise;
}

export function useTurnstile() {
  const holder = useRef<HTMLDivElement | null>(null);
  const widgetId = useRef<string | null>(null);
  const token = useRef<string | null>(null);
  const waiters = useRef<((t: string | undefined) => void)[]>([]);

  const settle = useCallback((t: string | undefined) => {
    const queue = waiters.current;
    waiters.current = [];
    queue.forEach((resolve) => resolve(t));
  }, []);

  useEffect(() => {
    if (!TURNSTILE_ENABLED) return;
    let cancelled = false;

    loadScript()
      .then(() => {
        if (cancelled || !holder.current || !window.turnstile) return;
        widgetId.current = window.turnstile.render(holder.current, {
          sitekey: TURNSTILE_SITE_KEY,
          // interaction-only keeps the widget out of sight until Cloudflare
          // actually wants a human — the invisible experience without
          // Turnstile's Invisible *mode*, which carries a contractual
          // requirement to cite its Privacy Addendum.
          appearance: "interaction-only",
          theme: "dark",
          size: "flexible",
          callback: (t) => {
            token.current = t;
            settle(t);
          },
          // A failed or expired challenge must not strand a waiting caller.
          "error-callback": () => {
            token.current = null;
            settle(undefined);
          },
          "expired-callback": () => {
            token.current = null;
            window.turnstile?.reset(widgetId.current ?? undefined);
          },
        });
      })
      .catch(() => {
        // Script blocked. Let callers through unchallenged.
        settle(undefined);
      });

    return () => {
      cancelled = true;
      if (widgetId.current && window.turnstile) {
        window.turnstile.remove(widgetId.current);
        widgetId.current = null;
      }
    };
  }, [settle]);

  const getToken = useCallback(async (): Promise<string | undefined> => {
    if (!TURNSTILE_ENABLED) return undefined;

    const take = () => {
      const t = token.current ?? undefined;
      if (t) {
        // Spent. Start earning the next one immediately so a second action in
        // the same visit is not left waiting from cold.
        token.current = null;
        window.turnstile?.reset(widgetId.current ?? undefined);
      }
      return t;
    };

    const ready = take();
    if (ready) return ready;

    return new Promise<string | undefined>((resolve) => {
      const timer = setTimeout(() => {
        waiters.current = waiters.current.filter((w) => w !== onSettle);
        resolve(undefined);
      }, TURNSTILE_TIMEOUT_MS);

      const onSettle = (t: string | undefined) => {
        clearTimeout(timer);
        if (t) {
          token.current = null;
          window.turnstile?.reset(widgetId.current ?? undefined);
        }
        resolve(t);
      };

      waiters.current.push(onSettle);
    });
  }, []);

  /**
   * Mount point. Renders nothing at all when the key is unset, and nothing
   * visible the rest of the time until Cloudflare decides otherwise.
   */
  const Widget = useCallback(
    () =>
      TURNSTILE_ENABLED ? <div ref={holder} /> : null,
    [],
  );

  return { getToken, Widget };
}
