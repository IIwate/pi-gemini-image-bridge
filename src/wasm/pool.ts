/**
 * pool.ts — Main-thread worker manager with Lazy Spawn & 30s Idle Timeout.
 *
 * Implements the Node.js/Piscina industry-standard lifecycle (decisions.md D12):
 * - Zero startup overhead: Worker is only spawned on-demand when a Tier 2/3 task arrives.
 * - Warm reuse: Worker stays warm for rapid consecutive image processing.
 * - Auto-reclaim: Automatically terminates after 30 seconds of inactivity to free memory.
 * - Fault tolerance: 5000ms hard timeout per task with automatic recovery.
 */

import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { WorkerTaskRequest, WorkerTaskResponse } from "./worker.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const WORKER_TIMEOUT_MS = 5000;
const IDLE_TIMEOUT_MS = 30_000; // Auto-terminate after 30s of inactivity

let singletonWorker: Worker | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let taskIdSeq = 0;
const pendingTasks = new Map<number, {
  resolve: (res: WorkerTaskResponse) => void;
  timer: NodeJS.Timeout;
}>();

function resetIdleTimer(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (pendingTasks.size === 0 && singletonWorker) {
    idleTimer = setTimeout(() => {
      terminateWorkerPool();
    }, IDLE_TIMEOUT_MS);
    idleTimer.unref();
  }
}

function createWorkerInstance(): Worker {
  const workerScriptPath = join(__dirname, "worker.ts");
  const worker = new Worker(workerScriptPath);
  worker.unref();

  worker.on("message", (msg: { type: string; response?: WorkerTaskResponse }) => {
    if (msg.type === "result" && msg.response) {
      const pending = pendingTasks.get(msg.response.id);
      if (pending) {
        clearTimeout(pending.timer);
        pendingTasks.delete(msg.response.id);
        if (pendingTasks.size === 0 && singletonWorker) {
          singletonWorker.unref();
          resetIdleTimer();
        }
        pending.resolve(msg.response);
      }
    }
  });

  worker.on("error", () => {
    for (const [id, task] of pendingTasks.entries()) {
      clearTimeout(task.timer);
      task.resolve({ id, ok: false, reason: "unreadable" });
    }
    pendingTasks.clear();
    singletonWorker = null;
    resetIdleTimer();
  });

  worker.on("exit", () => {
    // On unexpected exit, immediately fail all pending tasks without waiting for timeout
    for (const [id, task] of pendingTasks.entries()) {
      clearTimeout(task.timer);
      task.resolve({ id, ok: false, reason: "unreadable" });
    }
    pendingTasks.clear();
    singletonWorker = null;
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  });

  return worker;
}

function getOrSpawnWorker(): Worker {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (!singletonWorker) {
    singletonWorker = createWorkerInstance();
  }
  return singletonWorker;
}

/**
 * Dispatches an adaptive image processing task to the background worker thread.
 * Spawns the worker on demand if not already running.
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
          resetIdleTimer();
        }
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
 * Explicitly terminates the singleton worker thread to immediately reclaim memory.
 */
export async function terminateWorkerPool(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (singletonWorker) {
    const worker = singletonWorker;
    singletonWorker = null;
    await worker.terminate();
  }
}
