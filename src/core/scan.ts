/**
 * scan.ts — Pure functions for scanning clipboard image paths and self-contained placeholder tokens.
 *
 * Implements S.U.P.E.R. Architecture:
 * - Single Purpose: path scanning and token extraction only. No I/O, no Pi dependencies.
 * - Cross-Platform: handles mixed slashes, lowercase/uppercase drives, spaces in usernames.
 */

export const CLIPBOARD_FILE_RE_SOURCE =
  "pi-clipboard-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.(?:png|jpg|jpeg|webp|gif)";

/** Escapes a directory path segment for literal use inside a RegExp. */
function escapeRegExp(segment: string): string {
  return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Cross-platform filename extractor that splits on both `/` and `\`.
 * Guarantees correct extraction even when Windows paths are parsed in POSIX/WSL environments.
 */
export function extractFilename(filePath: string): string {
  if (!filePath) return "";
  const parts = filePath.split(/[\\/]+/);
  return parts[parts.length - 1] || filePath;
}

/**
 * Builds a RegExp matching `dropDir` followed by the clipboard filename pattern.
 * Allows any combination of `/` and `\` between directory segments and matches case-insensitively.
 */
function buildClipboardPathRegex(dropDir: string): RegExp {
  const isUnc = dropDir.startsWith("\\\\") || dropDir.startsWith("//");
  const isRoot = !isUnc && (dropDir.startsWith("/") || dropDir.startsWith("\\"));
  const segments = dropDir.split(/[\\/]+/).filter(Boolean);
  const escapedSegments = segments.map(escapeRegExp);

  let prefixPattern = escapedSegments.join("[\\\\/]+");
  if (isUnc) {
    prefixPattern = `[\\\\/]{2}${prefixPattern}`;
  } else if (isRoot) {
    prefixPattern = `[\\\\/]+${prefixPattern}`;
  }

  const separator = segments.length === 0 ? "" : "[\\\\/]+";
  // Only path-like ASCII characters can continue or prefix this generated path.
  // Unicode prose, including CJK text, may touch the path without making it invalid.
  const leftBoundary = "(?<![A-Za-z0-9_.:\\\\/-])";
  const rightBoundary = "(?![A-Za-z0-9_.:\\\\/-])";
  return new RegExp(
    `${leftBoundary}${prefixPattern}${separator}${CLIPBOARD_FILE_RE_SOURCE}${rightBoundary}`,
    "giu",
  );
}

/**
 * Returns clipboard-image paths found in `text`, in order of appearance, deduplicated.
 * `dropDir` is the platform temp directory (e.g. `os.tmpdir()`); both `/` and `\`
 * separators are accepted so the pattern works on WSL and Windows hosts.
 * Empty array when nothing matches.
 */
export function scanClipboardImagePaths(text: string, dropDir: string): string[] {
  if (!text || !dropDir) return [];
  const re = buildClipboardPathRegex(dropDir);

  const paths: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(re)) {
    const path = match[0];
    if (!seen.has(path)) {
      seen.add(path);
      paths.push(path);
    }
  }
  return paths;
}

export interface SelfContainedPlaceholderMatch {
  token: string;
  filename: string;
}

/**
 * Scans input text for self-contained image placeholder tokens, such as:
 *   "[Image #1: pi-clipboard-11112222-3333-4444-5555-666677778888.png]"
 *   "[Image #1: pi-clipboard-xxx.png (auto-scaled to 2560px to fit Gemini 100MB limit)]"
 *
 * Extracts the embedded filename directly for stateless, cross-session rehydration.
 */
export function scanSelfContainedPlaceholders(text: string): SelfContainedPlaceholderMatch[] {
  if (!text) return [];

  const regex = new RegExp(
    `\\[Image #\\d+:\\s*(${CLIPBOARD_FILE_RE_SOURCE})(?:\\s+\\(auto-scaled to (?:2560|2048)px to fit Gemini 100MB limit\\))?\\]`,
    "gi",
  );

  const results: SelfContainedPlaceholderMatch[] = [];
  const seenTokens = new Set<string>();

  for (const match of text.matchAll(regex)) {
    const token = match[0];
    const filename = match[1];
    if (!seenTokens.has(token)) {
      seenTokens.add(token);
      results.push({ token, filename });
    }
  }

  return results;
}
