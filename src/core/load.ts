/**
 * load.ts — Reads a clipboard-image file into base64 with a byte ceiling.
 *
 * The ceiling (50MB, decisions.md D5) exists because base64 inflates payloads ~1.37x and
 * oversized images risk upstream rejection. 50MB stays under Gemini API's 100MB
 * request-body limit after base64 expansion while leaving headroom. Errors are data, not exceptions: callers
 * branch on `ok` and never need try/catch (failure boundary, docs/architecture).
 */

import { readFile } from "node:fs/promises";

/** Byte ceiling for converted images; larger files are replaced with placeholder text. */
export const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

export interface LoadedImage {
  mimeType: string;
  /** Base64-encoded image bytes, without the `data:` prefix. */
  data: string;
}

export type LoadImageResult =
  | { ok: true; image: LoadedImage }
  | { ok: false; reason: "too-large" | "unreadable" };

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

function mimeTypeForPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

export async function loadImage(path: string): Promise<LoadImageResult> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    return { ok: false, reason: "too-large" };
  }
  return {
    ok: true,
    image: { mimeType: mimeTypeForPath(path), data: bytes.toString("base64") },
  };
}
