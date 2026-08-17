/**
 * worker.ts — Background worker thread for CPU-bound WebAssembly operations.
 *
 * Runs in a dedicated worker_thread (decisions.md D12) so that WASM compilation,
 * Lanczos3 floating-point math, and PNG encoding never freeze the main TUI event loop.
 */

import { parentPort } from "node:worker_threads";
import { readFile } from "node:fs/promises";
import { decodePng, encodePng, resizeLanczos3 } from "./engine.ts";

if (!parentPort) {
  throw new Error("worker.ts must be spawned as a worker_thread");
}

export interface WorkerTaskRequest {
  id: number;
  filePath: string;
  remainingBytes: number;
}

export type WorkerTaskResponse =
  | {
      id: number;
      ok: true;
      tier: "lossless" | "downscaled";
      mimeType: string;
      base64Data: string;
      rawBytesLength: number;
      annotation: string | null;
    }
  | {
      id: number;
      ok: false;
      reason: "too-large" | "unreadable";
    };

parentPort.on("message", async (msg: { type: "warmup" } | { type: "process"; task: WorkerTaskRequest }) => {
  if (!parentPort) return;

  if (msg.type === "warmup") {
    try {
      // Pre-warm WASM compilers by decoding and encoding a minimal 1x1 buffer
      const dummy = new Uint8Array(4);
      dummy.fill(255);
      const enc = await encodePng(dummy, 1, 1);
      await decodePng(enc);
      parentPort.postMessage({ type: "warmup_done" });
    } catch {
      // Warmup failures are non-fatal
    }
    return;
  }

  if (msg.type === "process") {
    const { id, filePath, remainingBytes } = msg.task;
    try {
      const rawBuffer = await readFile(filePath);
      const decoded = await decodePng(rawBuffer);

      // Tier 2: Lossless re-encoding (no resolution change)
      const losslessOptimized = await encodePng(decoded.data, decoded.width, decoded.height);
      if (losslessOptimized.length <= remainingBytes) {
        const response: WorkerTaskResponse = {
          id,
          ok: true,
          tier: "lossless",
          mimeType: "image/png",
          base64Data: Buffer.from(losslessOptimized.buffer, losslessOptimized.byteOffset, losslessOptimized.byteLength).toString("base64"),
          rawBytesLength: losslessOptimized.length,
          annotation: null,
        };
        parentPort.postMessage({ type: "result", response });
        return;
      }

      // Tier 3: Fidelity-Guarded Resampling (2560px floor -> 2048px floor)
      const targetScales = [2560, 2048];
      for (const maxDim of targetScales) {
        const maxOriginalDim = Math.max(decoded.width, decoded.height);
        if (maxOriginalDim <= maxDim) continue; // Already smaller than floor

        const scale = maxDim / maxOriginalDim;
        const targetWidth = Math.round(decoded.width * scale);
        const targetHeight = Math.round(decoded.height * scale);

        const resized = await resizeLanczos3(decoded.data, decoded.width, decoded.height, targetWidth, targetHeight);
        const reencoded = await encodePng(resized.data, resized.width, resized.height);

        if (reencoded.length <= remainingBytes) {
          const response: WorkerTaskResponse = {
            id,
            ok: true,
            tier: "downscaled",
            mimeType: "image/png",
            base64Data: Buffer.from(reencoded.buffer, reencoded.byteOffset, reencoded.byteLength).toString("base64"),
            rawBytesLength: reencoded.length,
            annotation: `(auto-scaled to ${maxDim}px to fit Gemini 100MB limit)`,
          };
          parentPort.postMessage({ type: "result", response });
          return;
        }
      }

      // If neither Tier 2 nor Tier 3 can fit within remaining budget
      const failResponse: WorkerTaskResponse = { id, ok: false, reason: "too-large" };
      parentPort.postMessage({ type: "result", response: failResponse });
    } catch {
      const errorResponse: WorkerTaskResponse = { id, ok: false, reason: "unreadable" };
      parentPort.postMessage({ type: "result", response: errorResponse });
    }
  }
});
