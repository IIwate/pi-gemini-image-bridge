/**
 * scan.ts — Matches Pi clipboard-image drop paths in input text.
 *
 * Pi's interactive paste handler (handleClipboardPaste) writes clipboard images to
 * `<os.tmpdir()>/pi-clipboard-<uuid>.<ext>` and inserts the bare path into the editor.
 * The drop directory is platform-dependent (decisions.md D3): `/tmp` on WSL/Linux,
 * `C:\Users\...\AppData\Local\Temp` on Windows.
 *
 * To ensure bulletproof Windows/POSIX matching:
 * 1. Path separators (`/` and `\`) are normalized to match either separator across segments.
 * 2. Case is ignored (`gi`), accommodating Windows drive-letter / path case variations.
 * 3. Spaces in directory names (e.g. `C:\Users\John Doe\...`) are preserved.
 */

const CLIPBOARD_FILE_RE_SOURCE =
  "pi-clipboard-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.(?:png|jpg|webp|gif)";

/** Escapes a directory path segment for literal use inside a RegExp. */
function escapeRegExp(segment: string): string {
  return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

  return new RegExp(`${prefixPattern}[\\\\/]+${CLIPBOARD_FILE_RE_SOURCE}`, "gi");
}

/**
 * Returns clipboard-image paths found in `text`, in order of appearance, deduplicated.
 * `dropDir` is the platform temp directory (e.g. `os.tmpdir()`); both `/` and `\`
 * separators are accepted so the pattern works on WSL and Windows hosts.
 * Empty array when nothing matches.
 */
export function scanClipboardImagePaths(text: string, dropDir: string): string[] {
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
