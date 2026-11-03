/**
 * Writes the Reference → Video prompt automatically once the Reference
 * Editor hands its merged job to Studio — server-side only, same reasoning
 * as OPENAI_API_KEY everywhere else in this app: this is the one place it
 * can live, and every call here is billed, so it's only ever reached
 * through /api/compose-prompt, which gates on sign-in first.
 *
 * Uses OpenAI's Chat Completions endpoint (not the images/edits endpoint
 * lib/providers/openai.ts calls) because this isn't editing an image, it's
 * writing prose from a mix of images — the lead clip's own trimmed video,
 * sampled into a handful of frames client-side (chat completions takes
 * images, not video files), plus every reference image the merged job is
 * about to carry, each with whatever headline the person typed for it in
 * the Reference Editor.
 *
 * The exact structure below (motion-guide line, "The cast:", a
 * format/camera line, one "Beat N (Image N):" line per image, an optional
 * cycling beat, a closing "Look:" paragraph) comes straight from a real
 * prompt the person wrote by hand for a fruit-swap ad and asked to have
 * auto-generated from now on — see the conversation this was built from.
 * The system prompt teaches that shape without hardcoding its content, so a
 * completely different set of clips and images still comes out as a
 * coherent prompt in the same voice.
 */

interface Beat {
  imageUrl: string;
  headline: string | null;
}

interface ComposePromptParams {
  aspectRatio: string;
  /** A handful of frames sampled across the lead clip's trimmed video,
   * data URLs — what the model reads to describe cut rhythm, timing and
   * camera framing, since it can't be handed the video file itself. */
  motionFrameDataUrls: string[];
  /** One entry per reference image the merged job will carry, in the exact
   * order they'll appear as Studio's "Image 1", "Image 2", etc. headline is
   * the text the person typed for that clip's own beat, or null if they
   * left it blank (later images from the same clip, if any, carry null —
   * see how ReferenceEditor builds this list). */
  beats: Beat[];
}

// Chat Completions, not the Responses API — the shape this app's one other
// OpenAI integration (images/edits) already uses elsewhere, and vision input
// via `image_url` content parts is the well-documented, stable way to hand a
// chat model images on this endpoint. Overridable without a code change,
// same reasoning as OPENAI_IMAGE_MODEL: this app has already had to move
// once this session when OpenAI retired a model out from under it.
const MODEL = process.env.OPENAI_PROMPT_MODEL ?? "gpt-4.1";

const SYSTEM_PROMPT = `You write prompts for an AI video generator's Reference → Video mode. Given a few sampled frames from a reference video (its motion, cut rhythm and camera framing — copy these, don't invent different ones) and a list of reference images in order (each becomes "Image 1", "Image 2", ... in the generator), write ONE prompt in exactly this structure, as plain prose — no markdown, no headings, no bullet points:

1. One opening paragraph: tell the generator to use the reference video as the motion guide, copying its editing rhythm, timing and cuts exactly, and to follow Image 1 through Image N as keyframes in order, replacing whatever the reference video's own subject is with each keyframe's subject in turn — describe concretely (from what you actually see in the images) what should stay identical across cuts (surfaces, props, on-screen text, etc.) versus what swaps each cut.
2. One sentence starting "The cast:" naming each distinct subject across the beats, in order, based on what you actually see in each reference image — be specific (color, variety, material), not generic.
3. One short paragraph describing the format: aspect ratio (given to you), and the camera/framing/cut-timing you actually observe in the sampled reference-video frames (angle, movement or lack of it, roughly how fast the cuts feel) — describe what's really there, don't default to someone else's shot description.
4. One line per beat, in order, formatted exactly as "Beat N (Image N): " followed by a concrete description of that image's scene — subject, surface, surrounding props, based on what you see. If a headline is given for that beat, end the line with exactly: Headline: "<the headline text>" — or, for the first beat only, you may instead write the headline as "Headline: \\"<text>\\"" once and later beats as "Headline changes to \\"<text>\\"." when the headline text differs from the previous beat's. If a beat has no headline, don't mention headlines in that line at all — never invent headline text that wasn't given to you.
5. If there is more than one beat, one additional short beat line after the last numbered beat, describing the cuts continuing to cycle back through all the setups in order for the rest of the video's length.
6. One closing paragraph starting "Look:" describing lighting, texture and color treatment consistent with what the reference images actually show, plus standard hygiene constraints: each object/subject keeps its exact shape and color across cuts, any on-screen text stays sharp and correctly spelled and doesn't move, no hands, no people, no extra objects beyond what's shown, no morphing between cuts, no logos.

Output only the prompt text itself, nothing else — no preamble, no explanation, no quotation marks around the whole thing.`;

function userContentParts(params: ComposePromptParams) {
  const parts: Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
  > = [
    {
      type: "text",
      text: `Aspect ratio: ${params.aspectRatio}\n\nReference video frames (motion/cut guide), sampled in order across the clip:`,
    },
    ...params.motionFrameDataUrls.map((url) => ({
      type: "image_url" as const,
      image_url: { url },
    })),
    {
      type: "text",
      text: `Keyframe images, in order (Image 1 is first). Each line below gives that image's headline, or "no headline" if none was typed:\n${params.beats
        .map((b, i) => `Image ${i + 1}: ${b.headline ? `headline "${b.headline}"` : "no headline"}`)
        .join("\n")}`,
    },
    ...params.beats.map((b) => ({
      type: "image_url" as const,
      image_url: { url: b.imageUrl },
    })),
  ];
  return parts;
}

export async function composeReferencePrompt(
  params: ComposePromptParams,
): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error(
      "OPENAI_API_KEY is not set. Create one at https://platform.openai.com/api-keys and add it to this app's environment variables.",
    );
  }
  if (params.beats.length === 0) {
    throw new Error("Need at least one reference image to write a prompt from.");
  }

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContentParts(params) },
      ],
      temperature: 0.7,
    }),
  });

  const json = (await res.json().catch(() => null)) as {
    choices?: { message?: { content?: string } }[];
    error?: { message?: string };
  } | null;

  if (!res.ok) {
    throw new Error(
      json?.error?.message ?? `OpenAI prompt composition failed (${res.status}).`,
    );
  }

  const text = json?.choices?.[0]?.message?.content?.trim();
  if (!text) {
    throw new Error("OpenAI returned no prompt text.");
  }
  return text;
}
