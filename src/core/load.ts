/**
 * load.ts — 4-Tier adaptive image loader with in-process WASM fallback.
 *
 * Implements the progressive degradation ladder (decisions.md D5, D9, D10, D11):
 * - Tier 1: Fast-Path Passthrough (≤ available budget, 0ms, 100% bit-level lossless)
 * - Tier 2: WASM Lossless Optimization (PNG lossless re-encoding without resolution loss)
 * - Tier 3: Fidelity-Guarded Resampling (Lanczos3 downscaling with 2560px/2048px floors)
 * - Tier 4: Hard Safety Floor (Honest omission placeholder, protecting Gemini's 100MB ceiling)
 */

import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import type { BudgetPool } from "./budget.ts";
import { decodePng, encodePng, resizeLanczos3 } from "../wasm/engine.ts";

export const MAX_SINGLE_IMAGE_BYTES = 50 * 1024 * 1024; // 50MB raw binary
export const MAX_HARD_FILE_BYTES = 100 * 1024 * 1024;   // 100MB hard limit before rejection

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export interface LoadedImage {
  type: "image";
  mimeType: string;
  data: string; // base64 (no data: prefix)
}

export type AdaptiveTier = "passthrough" | "lossless" | "downscaled";

export type AdaptiveLoadResult =
  | {
      ok: true;
      tier: AdaptiveTier;
      image: LoadedImage;
      annotation: string | null;
    }
  | {
      ok: false;
      reason: "too-large" | "unreadable";
    };

/**
 * Loads an image through the 4-tier adaptive pipeline, consuming payload budget greedily.
 */
export async function loadImageAdaptive(
  filePath: string,
  budgetPool: BudgetPool,
): Promise<AdaptiveLoadResult> {
  let stats;
  try {
    stats = await stat(filePath);
  } catch {
    return { ok: false, reason: "unreadable" };
  }

  // Hard sanity ceiling check (reject files beyond 100MB instantly)
  if (stats.size > MAX_HARD_FILE_BYTES) {
    return { ok: false, reason: "too-large" };
  }

  const ext = extname(filePath).toLowerCase();
  const mimeType = MIME_BY_EXT[ext] ?? "image/png";

  // -------------------------------------------------------------------------
  // Tier 1: Fast-Path Passthrough (0ms overhead, 100% bit-level lossless)
  // -------------------------------------------------------------------------
  if (stats.size <= budgetPool.remainingBytes && stats.size <= MAX_SINGLE_IMAGE_BYTES) {
    let buf: Buffer;
    try {
      buf = await readFile(filePath);
    } catch {
      return { ok: false, reason: "unreadable" };
    }

    const alloc = budgetPool.allocate(stats.size);
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
    return { ok: false, reason: "too-large" };
  }

  // -------------------------------------------------------------------------
  // Tier 2 & 3: WASM In-Process Processing (Lazy-loaded)
  // -------------------------------------------------------------------------
  try {
    const rawBuffer = await readFile(filePath);
    const decoded = await decodePng(rawBuffer);

    // Tier 2: Attempt lossless re-encoding without resolution change
    const losslessOptimized = await encodePng(decoded.data, decoded.width, decoded.height);
    if (losslessOptimized.length <= budgetPool.remainingBytes) {
      const alloc = budgetPool.allocate(losslessOptimized.length);
      if (alloc.granted) {
        return {
          ok: true,
          tier: "lossless",
          image: {
            type: "image",
            mimeType: "image/png",
            data: Buffer.from(losslessOptimized.buffer, losslessOptimized.byteOffset, losslessOptimized.byteLength).toString("base64"),
          },
          annotation: null,
        };
      }
    }

    // Tier 3: Fidelity-Guarded Resampling (2560px floor -> 2048px floor)
    const targetScales = [2560, 2048];
    for (const maxDim of targetScales) {
      const maxOriginalDim = Math.max(decoded.width, decoded.height);
      if (maxOriginalDim <= maxDim) continue; // Already smaller than this floor

      const scale = maxDim / maxOriginalDim;
      const targetWidth = Math.round(decoded.width * scale);
      const targetHeight = Math.round(decoded.height * scale);

      const resized = await resizeLanczos3(decoded.data, decoded.width, decoded.height, targetWidth, targetHeight);
      const reencoded = await encodePng(resized.data, resized.width, resized.height);

      if (reencoded.length <= budgetPool.remainingBytes) {
        const alloc = budgetPool.allocate(reencoded.length);
        if (alloc.granted) {
          return {
            ok: true,
            tier: "downscaled",
            image: {
              type: "image",
              mimeType: "image/png",
              data: Buffer.from(reencoded.buffer, reencoded.byteOffset, reencoded.byteLength).toString("base64"),
            },
            annotation: `(auto-scaled to ${maxDim}px to fit Gemini 100MB limit)`,
          };
        }
      }
    }
  } catch {
    // If WASM decoding/resizing fails on corrupted data, safely degrade to Tier 4
    return { ok: false, reason: "unreadable" };
  }

  // -------------------------------------------------------------------------
  // Tier 4: Hard Safety Floor
  // -------------------------------------------------------------------------
  return { ok: false, reason: "too-large" };
}
