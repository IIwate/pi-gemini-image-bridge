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
  /** The target string to replace in the original text (path or placeholder token). */
  target: string;
  /** `[Image #N]` or `[Image #N (auto-scaled...)]` label replacing the target when the conversion succeeded. */
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

export type FailureReason = "too-large" | "unreadable" | "missing-cache";

export const TOO_LARGE_PLACEHOLDER = "[image omitted: exceeds Gemini 100MB limit even after compression]";
export const UNREADABLE_PLACEHOLDER = "[image omitted: could not be read]";
export const MISSING_CACHE_PLACEHOLDER = "[image omitted: cached image no longer available on disk]";

/** Returns the placeholder text for a load failure reason. */
export function placeholderTextFor(reason: FailureReason): string {
  switch (reason) {
    case "too-large":
      return TOO_LARGE_PLACEHOLDER;
    case "missing-cache":
      return MISSING_CACHE_PLACEHOLDER;
    case "unreadable":
    default:
      return UNREADABLE_PLACEHOLDER;
  }
}

/**
 * Replaces every image target (path or placeholder) with its label or omission notice,
 * appending converted images after existing ones. Returns null when there is nothing to convert.
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
    out = out.replaceAll(item.target, replacement);
    if (item.image) {
      images.push(item.image);
    }
  }

  return { text: out, images };
}
