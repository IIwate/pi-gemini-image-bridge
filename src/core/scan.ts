/**
 * scan.ts — Matches Pi clipboard-image drop paths in input text.
 *
 * Pi's interactive paste handler (handleClipboardPaste) writes clipboard images to
 * `<os.tmpdir()>/pi-clipboard-<uuid>.<ext>` and inserts the bare path into the editor.
 * The drop directory is platform-dependent (decisions.md D3): `/tmp` on WSL/Linux,
 * `C:\Users\...\AppData\Local\Temp` on Windows. Only those files are converted; any
 * other path stays untouched so the plugin never hijacks unrelated image references.
 */

const CLIPBOARD_FILE_RE = /pi-clipboard-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpg|webp|gif)/;

/** Escapes a directory path for literal use inside a RegExp. */
function escapeRegExp(dir: string): string {
  return dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Returns clipboard-image paths found in `text`, in order of appearance, deduplicated.
 * `dropDir` is the platform temp directory (e.g. `os.tmpdir()`); both `/` and `\`
 * separators are accepted so the pattern works on WSL and Windows hosts.
 * Empty array when nothing matches.
 */
export function scanClipboardImagePaths(text: string, dropDir: string): string[] {
  const trimmedDir = dropDir.replace(/[\\/]+$/, "");
  const re = new RegExp(`${escapeRegExp(trimmedDir)}[\\\\/]${CLIPBOARD_FILE_RE.source}`, "g");

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
