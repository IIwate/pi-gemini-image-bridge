/**
 * pool.ts — Main-thread worker manager for background WASM execution.
 *
 * Manages a pre-warmed singleton worker_thread (decisions.md D12) with
 * a 5000ms hard timeout, auto-recovery on thread error, and zero main-thread freezing.
 */

import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { WorkerTaskRequest, WorkerTaskResponse } from "./worker.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const WORKER_TIMEOUT_MS = 5000;

let singletonWorker: Worker | null = null;
let taskIdSeq = 0;
const pendingTasks = new Map<number, {
  resolve: (res: WorkerTaskResponse) => void;
  timer: NodeJS.Timeout;
}>();

function createWorkerInstance(): Worker {
  const workerScriptPath = join(__dirname, "worker.ts");
  const worker = new Worker(workerScriptPath);
  // Unref worker thread handle so idle workers never hang the Node.js event loop
  worker.unref();

  worker.on("message", (msg: { type: string; response?: WorkerTaskResponse }) => {
    if (msg.type === "result" && msg.response) {
      const pending = pendingTasks.get(msg.response.id);
      if (pending) {
        clearTimeout(pending.timer);
        pendingTasks.delete(msg.response.id);
        if (pendingTasks.size === 0 && singletonWorker) {
          singletonWorker.unref();
        }
        pending.resolve(msg.response);
      }
    }
  });

  worker.on("error", () => {
    // On crash, reject all pending tasks and reset singleton
    for (const [id, task] of pendingTasks.entries()) {
      clearTimeout(task.timer);
      task.resolve({ id, ok: false, reason: "unreadable" });
    }
    pendingTasks.clear();
    singletonWorker = null;
  });

  worker.on("exit", () => {
    singletonWorker = null;
  });

  return worker;
}

function getOrSpawnWorker(): Worker {
  if (!singletonWorker) {
    singletonWorker = createWorkerInstance();
  }
  return singletonWorker;
}

/**
 * Triggers background pre-compilation and warm-up of WebAssembly modules.
 * Completely non-blocking and safe to call during extension initialization.
 */
export function warmupWorker(): void {
  try {
    const worker = getOrSpawnWorker();
    worker.postMessage({ type: "warmup" });
  } catch {
    // Warmup failure is non-fatal
  }
}

/**
 * Dispatches an adaptive image processing task to the background worker thread.
 */
export function processImageInWorker(
  filePath: string,
  remainingBytes: number,
): Promise<WorkerTaskResponse> {
  return new Promise((resolve) => {
    try {
      const worker = getOrSpawnWorker();
      worker.ref();
      const id = ++taskIdSeq;

      const timer = setTimeout(() => {
        pendingTasks.delete(id);
        if (pendingTasks.size === 0 && singletonWorker) {
          singletonWorker.unref();
        }
        // On hard timeout, terminate and recreate worker to unfreeze state
        try {
          worker.terminate();
        } catch {
          // ignore
        }
        singletonWorker = null;
        resolve({ id, ok: false, reason: "too-large" });
      }, WORKER_TIMEOUT_MS);

      pendingTasks.set(id, { resolve, timer });
      const task: WorkerTaskRequest = { id, filePath, remainingBytes };
      worker.postMessage({ type: "process", task });
    } catch {
      resolve({ id: 0, ok: false, reason: "unreadable" });
    }
  });
}

/**
 * Explicitly terminates the singleton worker thread (useful for clean test teardowns).
 */
export async function terminateWorkerPool(): Promise<void> {
  if (singletonWorker) {
    const worker = singletonWorker;
    singletonWorker = null;
    await worker.terminate();
  }
}
