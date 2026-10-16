"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

/**
 * Third-party replacement for the old in-house LiveChatWidget.
 *
 * Mounted once in the root layout, same as the component it replaces, so it
 * follows a visitor across every page. Unlike the old widget, there is no
 * app-side account, database, or polling involved at all — tawk.to runs its
 * own real-time connection straight from the visitor's browser to tawk.to's
 * servers, and you read/reply from the tawk.to dashboard (dashboard.tawk.to)
 * or their mobile apps, not from /admin.
 *
 * Needs two env vars, both public (they identify a widget, not a secret):
 *   NEXT_PUBLIC_TAWKTO_PROPERTY_ID
 *   NEXT_PUBLIC_TAWKTO_WIDGET_ID
 * Get both from tawk.to → Administration → Channels → Chat Widget → the
 * embed snippet shows them as the two path segments of the script src:
 * https://embed.tawk.to/<PROPERTY_ID>/<WIDGET_ID>
 *
 * If either is missing, this renders nothing rather than injecting a broken
 * script tag — safer for local dev / preview deploys with no env configured.
 */
export default function TawkToWidget() {
  const pathname = usePathname();
  const isAdminRoute = pathname?.startsWith("/admin") ?? false;

  const propertyId = process.env.NEXT_PUBLIC_TAWKTO_PROPERTY_ID;
  const widgetId = process.env.NEXT_PUBLIC_TAWKTO_WIDGET_ID;

  // Load the tawk.to embed script once, the same way their own snippet does.
  useEffect(() => {
    if (!propertyId || !widgetId) return;
    if (document.getElementById("tawkto-embed-script")) return;

    window.Tawk_API = window.Tawk_API || {};
    window.Tawk_LoadStart = new Date();

    const script = document.createElement("script");
    script.id = "tawkto-embed-script";
    script.async = true;
    script.src = `https://embed.tawk.to/${propertyId}/${widgetId}`;
    script.charset = "UTF-8";
    script.setAttribute("crossorigin", "*");

    const firstScript = document.getElementsByTagName("script")[0];
    firstScript?.parentNode?.insertBefore(script, firstScript);
  }, [propertyId, widgetId]);

  // Hide the bubble on /admin, same behavior as the old widget — an admin
  // browsing their own dashboard shouldn't see the visitor-facing bubble.
  // onLoaded covers the case where this effect runs before the widget has
  // actually finished loading; onBeforeLoadComplete alone would miss a
  // pathname change that happens after load.
  useEffect(() => {
    if (!propertyId || !widgetId) return;

    const apply = () => {
      if (isAdminRoute) {
        window.Tawk_API?.hideWidget?.();
      } else {
        window.Tawk_API?.showWidget?.();
      }
    };

    apply();
    window.Tawk_API = window.Tawk_API || {};
    const previousOnLoad = window.Tawk_API.onLoad;
    window.Tawk_API.onLoad = () => {
      previousOnLoad?.();
      apply();
    };
  }, [isAdminRoute, propertyId, widgetId]);

  return null;
}

declare global {
  interface Window {
    Tawk_API?: {
      hideWidget?: () => void;
      showWidget?: () => void;
      onLoad?: () => void;
      [key: string]: unknown;
    };
    Tawk_LoadStart?: Date;
  }
}
