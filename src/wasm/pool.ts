/**
 * pool.ts — Main-thread worker manager with Lazy Spawn & 30s Idle Timeout.
 *
 * Implements the worker lifecycle defined by decisions.md D12:
 * - Zero startup overhead: Worker is only spawned on-demand when a Tier 2/3 task arrives.
 * - Warm reuse: Worker stays warm for rapid consecutive image processing.
 * - Auto-reclaim: Automatically terminates after 30 seconds of inactivity to free memory.
 * - Fault tolerance: 5000ms hard timeout per task with automatic recovery.
 */

import { Worker } from "node:worker_threads";
import type {
  WorkerFailureReason,
  WorkerTaskRequest,
  WorkerTaskResponse,
} from "./protocol.ts";

const WORKER_TIMEOUT_MS = 5000;
const IDLE_TIMEOUT_MS = 30_000; // Auto-terminate after 30s of inactivity

let singletonWorker: Worker | null = null;
let idleTimer: { timer: NodeJS.Timeout; worker: Worker } | null = null;
let taskIdSeq = 0;
const pendingTasks = new Map<number, {
  resolve: (res: WorkerTaskResponse) => void;
  timer: NodeJS.Timeout;
  worker: Worker;
}>();

function hasPendingTasks(worker: Worker): boolean {
  for (const task of pendingTasks.values()) {
    if (task.worker === worker) return true;
  }
  return false;
}

function clearIdleTimer(worker?: Worker): void {
  if (idleTimer && (!worker || idleTimer.worker === worker)) {
    clearTimeout(idleTimer.timer);
    idleTimer = null;
  }
}

function scheduleIdleTermination(worker: Worker): void {
  clearIdleTimer();
  if (singletonWorker !== worker || hasPendingTasks(worker)) return;

  const timer = setTimeout(() => {
    if (singletonWorker === worker && !hasPendingTasks(worker)) {
      singletonWorker = null;
      void worker.terminate();
    }
    clearIdleTimer(worker);
  }, IDLE_TIMEOUT_MS);
  timer.unref();
  idleTimer = { timer, worker };
}

function detachWorker(worker: Worker): void {
  clearIdleTimer(worker);
  if (singletonWorker === worker) {
    singletonWorker = null;
  }
}

function failWorkerTasks(worker: Worker, reason: WorkerFailureReason): void {
  for (const [id, task] of pendingTasks.entries()) {
    if (task.worker !== worker) continue;
    clearTimeout(task.timer);
    pendingTasks.delete(id);
    task.resolve({ id, ok: false, reason });
  }
}

function createWorkerInstance(): Worker {
  const worker = new Worker(new URL("./worker.js", import.meta.url));
  worker.unref();

  worker.on("message", (msg: { type: string; response?: WorkerTaskResponse }) => {
    if (msg.type === "result" && msg.response) {
      const pending = pendingTasks.get(msg.response.id);
      if (pending?.worker === worker) {
        clearTimeout(pending.timer);
        pendingTasks.delete(msg.response.id);
        pending.resolve(msg.response);
        if (!hasPendingTasks(worker) && singletonWorker === worker) {
          worker.unref();
          scheduleIdleTermination(worker);
        }
      }
    }
  });

  worker.on("error", () => {
    detachWorker(worker);
    failWorkerTasks(worker, "unreadable");
  });

  worker.on("exit", () => {
    detachWorker(worker);
    failWorkerTasks(worker, "unreadable");
  });

  return worker;
}

function getOrSpawnWorker(): Worker {
  clearIdleTimer();
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
        const pending = pendingTasks.get(id);
        if (pending?.worker !== worker) return;

        pendingTasks.delete(id);
        detachWorker(worker);
        resolve({ id, ok: false, reason: "processing-timeout" });
        failWorkerTasks(worker, "processing-timeout");
        void worker.terminate();
      }, WORKER_TIMEOUT_MS);

      pendingTasks.set(id, { resolve, timer, worker });
      const task: WorkerTaskRequest = { id, filePath, remainingBytes };
      try {
        worker.postMessage({ type: "process", task });
      } catch {
        detachWorker(worker);
        failWorkerTasks(worker, "unreadable");
        void worker.terminate();
      }
    } catch {
      resolve({ id: 0, ok: false, reason: "unreadable" });
    }
  });
}

/**
 * Explicitly terminates the singleton worker thread to immediately reclaim memory.
 */
export async function terminateWorkerPool(): Promise<void> {
  clearIdleTimer();
  if (singletonWorker) {
    const worker = singletonWorker;
    detachWorker(worker);
    failWorkerTasks(worker, "unreadable");
    await worker.terminate();
  }
}
