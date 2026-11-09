"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Wraps a block of instructional copy and gives it one brief highlight flash
 * (see .flash-once in globals.css) the first time it actually scrolls into
 * view — not on mount (a lot of this app's own hint text sits below the
 * fold when the page first loads, so a flash-on-mount would fire while the
 * person is looking at something else entirely and be gone by the time they
 * scroll down to it) and never again after that first time (a paragraph
 * that flashes on every scroll past it reads as broken, not helpful).
 *
 * Built for copy that's easy to skim past without registering — the
 * Reference Editor's own explanatory paragraphs, mainly — not for anything
 * the person needs to act on immediately (a real error, a destructive
 * confirmation); those should already be impossible to miss without this.
 */
export default function FlashOnView({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [flashed, setFlashed] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || flashed) return;

    // Some browsers/test environments have no IntersectionObserver at all —
    // flash immediately rather than never, since a missed flash is harmless
    // but a silent no-op isn't.
    if (typeof IntersectionObserver === "undefined") {
      setFlashed(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setFlashed(true);
          observer.disconnect();
        }
      },
      { threshold: 0.4 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [flashed]);

  return (
    <div ref={ref} className={`${flashed ? "flash-once" : ""} ${className}`}>
      {children}
    </div>
  );
}
