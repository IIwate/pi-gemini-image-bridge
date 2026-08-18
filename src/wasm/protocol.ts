export interface WorkerTaskRequest {
  id: number;
  filePath: string;
  remainingBytes: number;
}

export type WorkerFailureReason = "budget-exhausted" | "processing-timeout" | "unreadable";

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
      reason: WorkerFailureReason;
    };
