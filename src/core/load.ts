/**
 * load.ts — 4-Tier Adaptive Image Loader.
 *
 * Implements S.U.P.E.R. Architecture & D9:
 * - Tier 1: Fast-Path Passthrough (0ms, 100% bit-exact lossless) for images within budget (<=50MB)
 * - Tier 2: WASM Lossless Optimization (in-process worker DEFLATE re-encoding without resolution loss)
 * - Tier 3: Fidelity-Guarded Resampling (Lanczos3 downscaling with hard floors at 2560px/2048px)
 * - Tier 4: Hard Safety Floor (honest placeholder omission on corruption or >100MB overflow)
 *
 * Pure & Ports over Implementation:
 * - Does not depend on Pi runtime.
 * - Delegates CPU-intensive WASM tasks to the background worker pool.
 */

import { stat, readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { BudgetPool } from "./budget.ts";
import type { FailureReason } from "./build.ts";
import { processImageInWorker } from "../wasm/pool.ts";

export const MAX_HARD_FILE_BYTES = 100 * 1024 * 1024; // 100MB physical safety ceiling

export type AdaptiveLoadResult =
  | {
      ok: true;
      image: { mimeType: string; data: string };
      annotation: string | null;
      tier: "passthrough" | "lossless" | "downscaled";
    }
  | {
      ok: false;
      reason: FailureReason;
    };

export function mimeTypeForExtension(ext: string): string {
  const normalized = ext.toLowerCase().replace(/^\./, "");
  switch (normalized) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    default:
      return "image/png";
  }
}

/**
 * Loads an image through the 4-tier adaptive fidelity pipeline.
 */
export async function loadImageAdaptive(
  filePath: string,
  budgetPool: BudgetPool,
): Promise<AdaptiveLoadResult> {
  let fileSizeBytes = 0;
  try {
    const fileStat = await stat(filePath);
    fileSizeBytes = fileStat.size;
  } catch {
    return { ok: false, reason: "unreadable" };
  }

  // Tier 4: Reject files physically exceeding 100MB immediately
  if (fileSizeBytes > MAX_HARD_FILE_BYTES) {
    return { ok: false, reason: "too-large" };
  }

  const mimeType = mimeTypeForExtension(extname(filePath));

  // Tier 1: Fast-Path Passthrough (100% bit-exact lossless)
  // If file fits comfortably within remaining budget, bypass WASM entirely.
  const alloc = budgetPool.allocate(fileSizeBytes);
  if (alloc.granted) {
    try {
      const buffer = await readFile(filePath);
      return {
        ok: true,
        image: { mimeType, data: buffer.toString("base64") },
        annotation: null,
        tier: "passthrough",
      };
    } catch {
      return { ok: false, reason: "unreadable" };
    }
  }

  // If even 1MB cannot be allocated, fail with budget overflow
  if (budgetPool.remainingBytes <= 0) {
    return { ok: false, reason: "too-large" };
  }

  // Tier 2 & 3: Offload to background worker thread (WASM Optimization / Lanczos3 Resampling)
  const remainingBudget = budgetPool.remainingBytes;
  const workerResult = await processImageInWorker(filePath, remainingBudget);

  if (workerResult.ok) {
    const workerAlloc = budgetPool.allocate(workerResult.rawBytesLength);
    if (workerAlloc.granted) {
      return {
        ok: true,
        image: { mimeType: workerResult.mimeType, data: workerResult.base64Data },
        annotation: workerResult.annotation ?? null,
        tier: workerResult.tier,
      };
    }
  }

  // Tier 4: Final Safety Floor
  return { ok: false, reason: workerResult.ok ? "too-large" : workerResult.reason };
}
