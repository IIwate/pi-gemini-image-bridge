/**
 * build.ts — Pure assembly of the transform payload and placeholder text.
 *
 * Implements S.U.P.E.R. Architecture:
 * - Single Purpose: pure text-substitution and attachment array assembly.
 * - Honest Omission: replaces invalid or missing images with clear bracketed notices.
 */

export interface ConvertedItem {
  /** The target string to replace in the original text (path or placeholder token). */
  target: string;
  label: string;
  image: { type: "image"; mimeType: string; data: string } | null;
  placeholder: string;
}

export type FailureReason = "unreadable" | "too-large" | "missing-cache";

export function placeholderTextFor(reason: FailureReason): string {
  switch (reason) {
    case "too-large":
      return "[image omitted: exceeds Gemini 100MB limit even after compression]";
    case "missing-cache":
      return "[image omitted: cached image no longer available on disk]";
    case "unreadable":
    default:
      return "[image omitted: unreadable or unsupported file]";
  }
}

export function buildTransform(
  originalText: string,
  existingImages: Array<{ type: "image"; mimeType: string; data: string }>,
  converted: ConvertedItem[],
): { text: string; images: Array<{ type: "image"; mimeType: string; data: string }> } | null {
  if (converted.length === 0) return null;

  let text = originalText;
  const newImages: Array<{ type: "image"; mimeType: string; data: string }> = [];

  for (const item of converted) {
    const replacement = item.image ? item.label : item.placeholder;
    text = text.replaceAll(item.target, replacement);
    if (item.image) {
      newImages.push(item.image);
    }
  }

  return {
    text,
    images: [...existingImages, ...newImages],
  };
}
