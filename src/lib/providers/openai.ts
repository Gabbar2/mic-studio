import sharp from "sharp";

/**
 * Real per-element image editing via OpenAI's images/edits endpoint —
 * server-side only, same reasoning as FAL_KEY in lib/providers/fal.ts: this
 * is the one place OPENAI_API_KEY can live, and every call here is billed,
 * so it's only ever reached through /api/edit-element, which gates on
 * sign-in and on the admin mock-mode switch (see lib/elementEditSettings.ts)
 * before this function is ever called.
 *
 * Scope decision: this sends exactly one image (the clip's frame) plus one
 * mask (that element's own selection) plus the typed instruction — not the
 * element's attached reference images too. OpenAI's edit endpoint's
 * documented, reliable shape is "one image + one mask + a prompt"; whether
 * it also accepts several input images *alongside* a mask in the same call
 * isn't something the public docs confirm, and guessing wrong here means a
 * failed, possibly still-billed call (see the cost conversation this was
 * built from). Reference images stay exactly what they were before this
 * file existed — context the person can describe in their own words in the
 * instruction text — until that's confirmed and worth the added cost.
 */

export interface EditImageResult {
  /** PNG bytes of the edited frame — the caller uploads these to storage. */
  bytes: Buffer;
}

interface EditElementImageParams {
  /** The clip's captured frame — https URL, already uploaded to storage. */
  imageUrl: string;
  /**
   * This element's own selection mask, in this app's own convention: opaque
   * where the element is, transparent everywhere else (the same file the
   * CSS highlight overlay already uses). Inverted below into OpenAI's own
   * convention before it's sent.
   */
  maskUrl: string;
  prompt: string;
}

// gpt-image-1 was retired by OpenAI on 2026-10-23; gpt-image-2 is its
// current successor for the edits endpoint. Overridable via env var without
// a code change, since OpenAI's lineup has already moved once this session.
const MODEL = process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-2";

async function fetchBytes(url: string): Promise<Buffer> {
  if (url.startsWith("data:")) {
    const base64 = url.slice(url.indexOf(",") + 1);
    return Buffer.from(base64, "base64");
  }
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Could not fetch ${url} (${res.status}).`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * OpenAI's edit mask is the opposite of this app's own: a fully transparent
 * pixel marks "regenerate this", an opaque one marks "keep this exactly as
 * it is". This app's masks mean the opposite (opaque = the selected
 * element) because that's what the CSS `mask-image` highlight technique
 * needs. `width`/`height` here are the TARGET canvas — the same one the
 * image gets fitted to in `fitToSize` below — not the mask's own native
 * size, and the resize uses the same "cover"/centered crop as that
 * function so the two stay pixel-aligned (see the comment on
 * editElementImage for why that match matters).
 */
async function buildOpenAiMask(
  maskBytes: Buffer,
  width: number,
  height: number,
): Promise<Buffer> {
  const { data, info } = await sharp(maskBytes)
    .resize(width, height, { fit: "cover", position: "center" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const inverted = Buffer.from(data);
  for (let i = 3; i < inverted.length; i += 4) {
    inverted[i] = inverted[i]! > 127 ? 0 : 255;
  }

  return sharp(inverted, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .png()
    .toBuffer();
}

/** Maps the frame's own aspect ratio onto the three sizes gpt-image-1
 * actually supports, rather than leaving size unset and hoping the result
 * happens to match — a square result cropped out of a portrait frame would
 * silently lose most of the scene. */
function pickSize(
  width: number,
  height: number,
): "1024x1024" | "1536x1024" | "1024x1536" {
  if (width > height * 1.1) return "1536x1024";
  if (height > width * 1.1) return "1024x1536";
  return "1024x1024";
}

function parseSize(size: string): { width: number; height: number } {
  const [width, height] = size.split("x").map(Number);
  return { width, height };
}

/**
 * Crops+scales ("cover", centered) the frame to exactly the canvas named in
 * `size` above, instead of uploading the frame at its own native
 * resolution. Fixes a real misalignment bug: `size` was being sent to
 * OpenAI as one of only three fixed buckets (close to the frame's aspect
 * ratio, but rarely exact — e.g. a 9:16 capture bucketed into 1024x1536,
 * which is 2:3), while the `image` and `mask` files were uploaded at the
 * frame's own, different-aspect native resolution. OpenAI has to make the
 * image it actually edits match the `size` canvas somehow, and whatever it
 * did internally to reconcile that (crop, pad, or stretch) wasn't
 * reflected in our mask, which was still aligned to the original,
 * uncropped frame — so the edit (and any new content the model added
 * while reconciling the mismatch) could land anywhere relative to the
 * highlighted selection. Resizing the image ourselves to the exact
 * declared canvas, with the mask forced through the identical transform in
 * buildOpenAiMask, removes that ambiguity: image, mask, and the `size` we
 * claim are now all the same canvas, so there's nothing left for OpenAI to
 * silently reconcile.
 */
async function fitToSize(
  bytes: Buffer,
  width: number,
  height: number,
): Promise<Buffer> {
  return sharp(bytes)
    .resize(width, height, { fit: "cover", position: "center" })
    .png()
    .toBuffer();
}

export async function editElementImage({
  imageUrl,
  maskUrl,
  prompt,
}: EditElementImageParams): Promise<EditImageResult> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error(
      "OPENAI_API_KEY is not set. Create one at https://platform.openai.com/api-keys and add it to this app's environment variables.",
    );
  }

  const [imageBytes, maskBytes] = await Promise.all([
    fetchBytes(imageUrl),
    fetchBytes(maskUrl),
  ]);

  // Re-encoded to PNG regardless of the frame's own format (it's captured
  // as JPEG — see videoThumbnail.ts) — the edits endpoint's image+mask flow
  // is documented and tested against PNG; converting here removes any
  // doubt rather than hoping a JPEG input is accepted too.
  const pngImageNative = await sharp(imageBytes).png().toBuffer();
  const meta = await sharp(pngImageNative).metadata();
  const nativeWidth = meta.width ?? 1024;
  const nativeHeight = meta.height ?? 1024;

  const size = pickSize(nativeWidth, nativeHeight);
  const { width, height } = parseSize(size);

  // Both fitted to the exact same target canvas (see fitToSize's doc
  // comment) — this is what keeps the mask lined up with what actually
  // gets edited, instead of the frame going out at its own native
  // resolution while `size` below claims a different one.
  const pngImage = await fitToSize(pngImageNative, width, height);
  const openAiMask = await buildOpenAiMask(maskBytes, width, height);

  const form = new FormData();
  form.append("model", MODEL);
  form.append("prompt", prompt);
  form.append("size", size);
  form.append(
    "image",
    new Blob([new Uint8Array(pngImage)], { type: "image/png" }),
    "frame.png",
  );
  form.append(
    "mask",
    new Blob([new Uint8Array(openAiMask)], { type: "image/png" }),
    "mask.png",
  );

  const res = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });

  const json = (await res.json().catch(() => null)) as {
    data?: { b64_json?: string; url?: string }[];
    error?: { message?: string };
  } | null;

  if (!res.ok) {
    throw new Error(
      json?.error?.message ?? `OpenAI image edit failed (${res.status}).`,
    );
  }

  const first = json?.data?.[0];
  if (first?.b64_json) {
    return { bytes: Buffer.from(first.b64_json, "base64") };
  }
  if (first?.url) {
    return { bytes: await fetchBytes(first.url) };
  }
  throw new Error("OpenAI returned no image.");
}
