/**
 * load.ts — 4-Tier adaptive image loader with background worker offloading.
 *
 * Implements the progressive degradation ladder (decisions.md D5, D9, D10, D11, D12):
 * - Tier 1: Fast-Path Passthrough (≤ available budget, 0ms, 100% bit-level lossless)
 * - Tier 2: WASM Lossless Optimization (PNG lossless re-encoding via background worker)
 * - Tier 3: Fidelity-Guarded Resampling (Lanczos3 downscaling via background worker)
 * - Tier 4: Hard Safety Floor (Honest omission placeholder, protecting Gemini's 100MB ceiling)
 */

import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import type { BudgetPool } from "./budget.ts";
import type { FailureReason } from "./build.ts";
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
  // Tier 2 & 3: Offload to Background Worker Thread (0ms main thread blocking)
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
  return { ok: false, reason: workerResult.ok ? "too-large" : workerResult.reason };
}
