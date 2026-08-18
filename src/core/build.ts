/**
 * build.ts — Assembles the transform payload: placeholder text + merged images.
 *
 * Pi's extension runner replaces `images` when a transform returns the field
 * (`result.images ?? currentImages`), so existing event images must be re-included
 * explicitly (decisions.md D7). Failed conversions become placeholder text — the original
 * path must never survive in the outgoing text for Gemini (decisions.md D6), because it
 * would route the model back into the broken read-tool image path.
 */

import type { FailureReason } from "./load.ts";

/** Structural subset of pi-ai's ImageContent; kept local so core stays Pi-free. */
export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface ConvertedItem {
  /** The target string to replace in the original text (path or placeholder token). */
  target: string;
  /** Self-contained label (e.g. `[Image #N: filename]`) replacing the target when succeeded. */
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

export const TOO_LARGE_PLACEHOLDER = "[image omitted: exceeds 100MB hard file limit]";
export const BUDGET_EXHAUSTED_PLACEHOLDER =
  "[image omitted: does not fit remaining request image budget]";
export const PROCESSING_TIMEOUT_PLACEHOLDER = "[image omitted: image processing timed out]";
export const UNREADABLE_PLACEHOLDER = "[image omitted: could not be read]";
export const EXPIRED_PLACEHOLDER = "[image omitted: clipboard temp file expired or missing from disk]";

/** Returns the placeholder text for a load failure reason. */
export function placeholderTextFor(reason: FailureReason): string {
  switch (reason) {
    case "too-large":
      return TOO_LARGE_PLACEHOLDER;
    case "budget-exhausted":
      return BUDGET_EXHAUSTED_PLACEHOLDER;
    case "processing-timeout":
      return PROCESSING_TIMEOUT_PLACEHOLDER;
    case "expired":
      return EXPIRED_PLACEHOLDER;
    case "unreadable":
    default:
      return UNREADABLE_PLACEHOLDER;
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replaces every image target (path or placeholder) with its label or omission notice,
 * appending converted images after existing ones.
 *
 * Uses single-pass RegExp replacement with length-descending sorting to completely eliminate:
 * 1. Double substitution (e.g. replacing a path with "[Image #2:...]" which is later re-replaced)
 * 2. Prefix collision (e.g. "[Image #1:...]" accidentally corrupting "[Image #10:...]")
 *
 * Returns null when there is nothing to convert.
 */
export function buildTransform(
  originalText: string,
  existingImages: ImageContent[],
  converted: ConvertedItem[],
): TransformResult | null {
  if (converted.length === 0) return null;

  const replacementMap = new Map<string, string>();
  const newImages: ImageContent[] = [];

  for (const item of converted) {
    const replacement = item.image ? item.label : item.placeholder;
    replacementMap.set(item.target, replacement);
    if (item.image) {
      newImages.push(item.image);
    }
  }

  // Sort keys by length descending to ensure longer tokens match first
  const sortedKeys = Array.from(replacementMap.keys()).sort((a, b) => b.length - a.length);
  if (sortedKeys.length === 0) return null;

  const unionPattern = sortedKeys.map(escapeRegExp).join("|");
  const regex = new RegExp(unionPattern, "g");

  // Single-pass replacement guarantees no token is ever scanned or replaced twice
  const text = originalText.replace(regex, (matched) => {
    return replacementMap.get(matched) ?? matched;
  });

  return {
    text,
    images: [...existingImages, ...newImages],
  };
}
