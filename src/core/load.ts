/**
 * load.ts — 4-Tier adaptive image loader with background worker offloading.
 *
 * Implements the progressive degradation ladder (decisions.md D5, D9, D10, D11, D12):
 * - Tier 1: Structure-Validated Passthrough (within budget, original bytes preserved)
 * - Tier 2: WASM Lossless Optimization (PNG lossless re-encoding via background worker)
 * - Tier 3: Fidelity-Guarded Resampling (Lanczos3 downscaling via background worker)
 * - Tier 4: Hard Safety Floor (Honest omission placeholder, protecting Gemini's 100MB ceiling)
 */

import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import type { BudgetPool } from "./budget.ts";
import { processImageInWorker } from "../wasm/pool.ts";

export const MAX_SINGLE_IMAGE_BYTES = 50 * 1024 * 1024; // 50MB raw binary
export const MAX_HARD_FILE_BYTES = 100 * 1024 * 1024;   // 100MB hard limit before rejection

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function hasPngStructure(buffer: Buffer): boolean {
  if (buffer.length < 45 || !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return false;
  }

  let offset = PNG_SIGNATURE.length;
  let sawHeader = false;
  let sawImageData = false;

  while (offset + 12 <= buffer.length) {
    const dataLength = buffer.readUInt32BE(offset);
    const chunkEnd = offset + 12 + dataLength;
    if (chunkEnd > buffer.length) return false;

    const chunkType = buffer.toString("ascii", offset + 4, offset + 8);
    if (!sawHeader) {
      if (chunkType !== "IHDR" || dataLength !== 13) return false;
      sawHeader = true;
    } else if (chunkType === "IDAT") {
      sawImageData = true;
    } else if (chunkType === "IEND") {
      return dataLength === 0 && sawImageData;
    }

    offset = chunkEnd;
  }

  return false;
}

function hasExpectedImageStructure(ext: string, buffer: Buffer): boolean {
  switch (ext) {
    case ".png":
      return hasPngStructure(buffer);
    case ".jpg":
    case ".jpeg":
      return (
        buffer.length >= 4 &&
        buffer[0] === 0xff &&
        buffer[1] === 0xd8 &&
        buffer[2] === 0xff &&
        buffer.lastIndexOf(Buffer.from([0xff, 0xd9])) >= 3
      );
    case ".webp":
      return (
        buffer.length >= 16 &&
        buffer.toString("ascii", 0, 4) === "RIFF" &&
        buffer.toString("ascii", 8, 12) === "WEBP" &&
        buffer.readUInt32LE(4) + 8 <= buffer.length
      );
    case ".gif": {
      const header = buffer.toString("ascii", 0, 6);
      return (
        buffer.length >= 14 &&
        (header === "GIF87a" || header === "GIF89a") &&
        buffer.lastIndexOf(0x3b) >= 13
      );
    }
    default:
      return false;
  }
}

export interface LoadedImage {
  type: "image";
  mimeType: string;
  data: string; // base64 (no data: prefix)
}

export type AdaptiveTier = "passthrough" | "lossless" | "downscaled";

export type FailureReason =
  | "too-large"
  | "budget-exhausted"
  | "processing-timeout"
  | "unreadable"
  | "expired";

export type AdaptiveLoadResult =
  | {
      ok: true;
      tier: AdaptiveTier;
      image: LoadedImage;
      annotation: string | null;
    }
  | {
      ok: false;
      reason: FailureReason;
    };

/**
 * Loads an image through the 4-tier adaptive pipeline, consuming payload budget greedily.
 * Heavy WASM computation is offloaded to a background worker thread (D12).
 */
export async function loadImageAdaptive(
  filePath: string,
  budgetPool: BudgetPool,
): Promise<AdaptiveLoadResult> {
  let stats;
  try {
    stats = await stat(filePath);
  } catch {
    return { ok: false, reason: "expired" };
  }

  // Hard sanity ceiling check (reject files beyond 100MB instantly)
  if (stats.size > MAX_HARD_FILE_BYTES) {
    return { ok: false, reason: "too-large" };
  }

  const ext = extname(filePath).toLowerCase();
  const mimeType = MIME_BY_EXT[ext];
  if (!mimeType) {
    return { ok: false, reason: "unreadable" };
  }

  // -------------------------------------------------------------------------
  // Tier 1: Structure-Validated Passthrough (no WASM, original bytes preserved)
  // -------------------------------------------------------------------------
  if (stats.size <= budgetPool.remainingBytes && stats.size <= MAX_SINGLE_IMAGE_BYTES) {
    let buf: Buffer;
    try {
      buf = await readFile(filePath);
    } catch {
      return { ok: false, reason: "unreadable" };
    }

    if (buf.length > MAX_HARD_FILE_BYTES) {
      return { ok: false, reason: "too-large" };
    }
    if (!hasExpectedImageStructure(ext, buf)) {
      return { ok: false, reason: "unreadable" };
    }

    const alloc = budgetPool.allocate(buf.length);
    if (alloc.granted) {
      return {
        ok: true,
        tier: "passthrough",
        image: {
          type: "image",
          mimeType,
          data: buf.toString("base64"),
        },
        annotation: null,
      };
    }
  }

  // If not a PNG or remaining budget is exhausted, cannot run WASM optimization
  if (ext !== ".png" || budgetPool.remainingBytes <= 0) {
    return { ok: false, reason: "budget-exhausted" };
  }

  // -------------------------------------------------------------------------
  // Tier 2 & 3: Keep CPU-bound codec work off the main thread
  // -------------------------------------------------------------------------
  const workerResult = await processImageInWorker(filePath, budgetPool.remainingBytes);
  if (workerResult.ok) {
    const alloc = budgetPool.allocate(workerResult.rawBytesLength);
    if (alloc.granted) {
      return {
        ok: true,
        tier: workerResult.tier,
        image: {
          type: "image",
          mimeType: workerResult.mimeType,
          data: workerResult.base64Data,
        },
        annotation: workerResult.annotation,
      };
    }
  }

  // -------------------------------------------------------------------------
  // Tier 4: Hard Safety Floor
  // -------------------------------------------------------------------------
  return { ok: false, reason: workerResult.ok ? "budget-exhausted" : workerResult.reason };
}
