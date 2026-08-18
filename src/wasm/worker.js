// @ts-check

/**
 * worker.js - Background worker thread for CPU-bound WebAssembly operations.
 *
 * The worker processes messages serially to bound peak memory usage across concurrent inputs.
 */

import { parentPort } from "node:worker_threads";
import { readFile } from "node:fs/promises";
import { decodePng, encodePng, resizeLanczos3 } from "./engine.js";

if (!parentPort) {
  throw new Error("worker.js must be spawned as a worker_thread");
}

const workerPort = parentPort;

/** @param {import("./protocol.ts").WorkerTaskRequest} task */
async function processTask(task) {
  const { id, filePath, remainingBytes } = task;
  try {
    const rawBuffer = await readFile(filePath);
    const decoded = await decodePng(rawBuffer);

    const losslessOptimized = await encodePng(decoded.data, decoded.width, decoded.height);
    if (losslessOptimized.length <= remainingBytes) {
      /** @type {import("./protocol.ts").WorkerTaskResponse} */
      const response = {
        id,
        ok: true,
        tier: "lossless",
        mimeType: "image/png",
        base64Data: Buffer.from(
          losslessOptimized.buffer,
          losslessOptimized.byteOffset,
          losslessOptimized.byteLength,
        ).toString("base64"),
        rawBytesLength: losslessOptimized.length,
        annotation: null,
      };
      workerPort.postMessage({ type: "result", response });
      return;
    }

    for (const maxDim of [2560, 2048]) {
      const maxOriginalDim = Math.max(decoded.width, decoded.height);
      if (maxOriginalDim <= maxDim) continue;

      const scale = maxDim / maxOriginalDim;
      const targetWidth = Math.round(decoded.width * scale);
      const targetHeight = Math.round(decoded.height * scale);
      const resized = await resizeLanczos3(
        decoded.data,
        decoded.width,
        decoded.height,
        targetWidth,
        targetHeight,
      );
      const reencoded = await encodePng(resized.data, resized.width, resized.height);

      if (reencoded.length <= remainingBytes) {
        /** @type {import("./protocol.ts").WorkerTaskResponse} */
        const response = {
          id,
          ok: true,
          tier: "downscaled",
          mimeType: "image/png",
          base64Data: Buffer.from(
            reencoded.buffer,
            reencoded.byteOffset,
            reencoded.byteLength,
          ).toString("base64"),
          rawBytesLength: reencoded.length,
          annotation: `(auto-scaled to ${maxDim}px to fit Gemini 100MB limit)`,
        };
        workerPort.postMessage({ type: "result", response });
        return;
      }
    }

    /** @type {import("./protocol.ts").WorkerTaskResponse} */
    const response = { id, ok: false, reason: "budget-exhausted" };
    workerPort.postMessage({ type: "result", response });
  } catch {
    /** @type {import("./protocol.ts").WorkerTaskResponse} */
    const response = { id, ok: false, reason: "unreadable" };
    workerPort.postMessage({ type: "result", response });
  }
}

/** @param {{ type: "warmup" } | { type: "process", task: import("./protocol.ts").WorkerTaskRequest }} message */
async function handleMessage(message) {
  if (message.type === "warmup") {
    try {
      const dummy = new Uint8Array(4);
      dummy.fill(255);
      const encoded = await encodePng(dummy, 1, 1);
      await decodePng(encoded);
      workerPort.postMessage({ type: "warmup_done", ok: true });
    } catch {
      workerPort.postMessage({ type: "warmup_done", ok: false });
    }
    return;
  }

  await processTask(message.task);
}

let queue = Promise.resolve();
workerPort.on("message", (message) => {
  queue = queue.then(() => handleMessage(message));
});
