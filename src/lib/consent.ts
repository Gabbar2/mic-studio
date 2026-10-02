/**
 * Upload consent.
 *
 * Card-network rules reach us through whichever processor we use, and the
 * relevant one here is blunt: content generated from user-supplied material
 * has to be controlled, and using a real person's likeness without their
 * permission is prohibited outright rather than merely discouraged.
 *
 * A checkbox does not make that true. What it does is three things that
 * matter:
 *
 *   1. It puts the obligation in front of the person at the moment they act,
 *      rather than buried in terms nobody opens.
 *   2. It creates a record — who, when, which file, which wording — so a
 *      complaint can be answered with evidence rather than assurances.
 *   3. It is the difference between an application that describes a process
 *      and one that describes an intention.
 *
 * The version string is the point of the record. Wording changes over time,
 * and "they agreed to something" is worth far less than "they agreed to
 * exactly this sentence, on this date".
 */

/** Bump whenever CONSENT_TEXT changes. Never reuse an old version string. */
export const CONSENT_VERSION = "2026-08-11";

export const CONSENT_TEXT =
  "I have the right to use this file, and any identifiable person in it has " +
  "given me permission to use their likeness to generate video.";

/** Shown under the checkbox. Short on purpose — the ban list lives in /terms. */
export const CONSENT_HINT =
  "No impersonation, no face swaps, and no public figures without consent.";
