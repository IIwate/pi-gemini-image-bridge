/**
 * build.ts — Assembles the transform payload: placeholder text + merged images.
 *
 * Pi's extension runner replaces `images` when a transform returns the field
 * (`result.images ?? currentImages`), so existing event images must be re-included
 * explicitly (decisions.md D7). Failed conversions become placeholder text — the original
 * path must never survive in the outgoing text (decisions.md D6), because it would route
 * the model back into the broken read-tool image path.
 */

/** Structural subset of pi-ai's ImageContent; kept local so core stays Pi-free. */
export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface ConvertedItem {
  path: string;
  /** `[Image #N]` or `[Image #N (auto-scaled...)]` label replacing the path when the conversion succeeded. */
  label: string;
  /** Converted image, or null when the conversion failed. */
  image: ImageContent | null;
  /** Placeholder text used when `image` is null. */
  placeholder: string;
}

export interface TransformResult {
  text: string;
  images: ImageContent[];
}

export const TOO_LARGE_PLACEHOLDER = "[image omitted: exceeds Gemini 100MB limit even after compression]";
export const UNREADABLE_PLACEHOLDER = "[image omitted: could not be read]";

/** Returns the placeholder text for a load failure reason. */
export function placeholderTextFor(reason: "too-large" | "unreadable"): string {
  return reason === "too-large" ? TOO_LARGE_PLACEHOLDER : UNREADABLE_PLACEHOLDER;
}

/**
 * Replaces every image path with its label or placeholder, appending converted
 * images after the existing ones. Returns null when there is nothing to convert.
 */
export function buildTransform(
  text: string,
  existingImages: ImageContent[],
  converted: ConvertedItem[],
): TransformResult | null {
  if (converted.length === 0) return null;

  let out = text;
  const images = [...existingImages];
  for (const item of converted) {
    const replacement = item.image ? item.label : item.placeholder;
    out = out.split(item.path).join(replacement);
    if (item.image) images.push(item.image);
  }
  return { text: out, images };
}
