/**
 * display.ts - Presentation-only formatting for self-contained image labels.
 *
 * The full label remains in session/model text so stateless rehydration can
 * recover the clipboard filename. Pi's Markdown transformer uses this helper
 * only when rendering the interactive transcript.
 */

import { CLIPBOARD_FILE_RE_SOURCE } from "./scan.ts";

const SELF_CONTAINED_LABEL_RE = new RegExp(
  `\\[Image #(\\d+):\\s*(${CLIPBOARD_FILE_RE_SOURCE})(?:\\s+\\(auto-scaled to (?:2560|2048)px to fit Gemini 100MB limit\\))?\\]`,
  "gi",
);

/** Replaces long transport labels with compact transcript labels. */
export function compactImageLabelsForDisplay(markdown: string): string {
  if (!markdown) return markdown;
  return markdown.replace(SELF_CONTAINED_LABEL_RE, (_match, index: string) => `[Image #${index}]`);
}
