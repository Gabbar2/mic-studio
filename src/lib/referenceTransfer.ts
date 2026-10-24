"use client";

/**
 * The hand-off between the Reference Editor and Studio.
 *
 * Deliberately sessionStorage, not a URL query string or a new database
 * table: the transfer package references real uploaded-media URLs and a
 * model id, which is small, but a project could carry several segments —
 * still small, but there's no reason to make it part of the shareable
 * /studio URL, and it needs nothing durable (it's consumed once, in the same
 * browser tab, right after the editor sends you here). Session-scoped and
 * tab-scoped is exactly the right lifetime for "I just built this, go
 * generate it."
 */

export interface ReferenceTransferJob {
  /** Stable within one transfer; used for the "job 2 of 3" progress label. */
  id: string;
  modelId: string;
  /** Already-uploaded Supabase Storage URL for the real trimmed/split clip. */
  referenceVideoUrl: string;
  referenceVideoDurationSeconds: number;
  referenceImageUrls: string[];
  prompt: string;
  aspectRatio: "16:9" | "9:16" | "1:1";
}

const KEY = "mic-studio:reference-transfer";

export function writeReferenceTransfer(jobs: ReferenceTransferJob[]): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ jobs, cursor: 0 }));
  } catch {
    // Private browsing / storage disabled — the "Continue in Mic Studio"
    // button still navigates, it just arrives at a blank composer instead of
    // a prefilled one. Nothing to recover from here.
  }
}

export function readReferenceTransfer(): {
  jobs: ReferenceTransferJob[];
  cursor: number;
} | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      jobs: ReferenceTransferJob[];
      cursor: number;
    };
    if (!Array.isArray(parsed.jobs) || !parsed.jobs.length) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function advanceReferenceTransferCursor(nextCursor: number): void {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as {
      jobs: ReferenceTransferJob[];
      cursor: number;
    };
    sessionStorage.setItem(
      KEY,
      JSON.stringify({ jobs: parsed.jobs, cursor: nextCursor }),
    );
  } catch {
    // Nothing to persist to — the in-memory cursor Studio already holds
    // keeps working for the rest of this page view either way.
  }
}

export function clearReferenceTransfer(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
}
