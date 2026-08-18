/**
 * budget.ts — Dynamic greedy budget pool for multi-image prompts.
 *
 * Derives a safe binary ceiling (default 50MB raw binary, ~66.7MB Base64) from
 * Gemini API's official 100MB request limit, leaving ~33.3MB for system instructions,
 * tools, and multi-turn context (decisions.md D5 & D11).
 */

export const DEFAULT_MAX_REQUEST_BYTES = 50 * 1024 * 1024; // 50MB raw binary

export interface BudgetAllocation {
  granted: boolean;
  allocatedBytes: number;
  remainingBytes: number;
}

export interface BudgetPool {
  readonly totalBytes: number;
  readonly remainingBytes: number;
  allocate(neededBytes: number): BudgetAllocation;
}

/** Returns the decoded byte length of an unprefixed Base64 payload. */
export function base64DecodedByteLength(data: string): number {
  if (data.length === 0) return 0;

  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

/**
 * Creates a greedy budget pool that allocates binary payload budget in order of request.
 * Existing request attachments consume the same request-level ceiling before new allocations.
 */
export function createBudgetPool(
  totalBytes = DEFAULT_MAX_REQUEST_BYTES,
  reservedBytes = 0,
): BudgetPool {
  if (!Number.isFinite(totalBytes) || totalBytes < 0) {
    throw new RangeError("totalBytes must be a finite non-negative number");
  }
  if (!Number.isFinite(reservedBytes) || reservedBytes < 0) {
    throw new RangeError("reservedBytes must be a finite non-negative number");
  }

  let remaining = Math.max(0, totalBytes - reservedBytes);

  return {
    get totalBytes() {
      return totalBytes;
    },
    get remainingBytes() {
      return remaining;
    },
    allocate(neededBytes: number): BudgetAllocation {
      if (neededBytes <= 0 || !Number.isFinite(neededBytes)) {
        return {
          granted: false,
          allocatedBytes: 0,
          remainingBytes: remaining,
        };
      }
      if (neededBytes <= remaining) {
        remaining -= neededBytes;
        return {
          granted: true,
          allocatedBytes: neededBytes,
          remainingBytes: remaining,
        };
      }
      return {
        granted: false,
        allocatedBytes: 0,
        remainingBytes: remaining,
      };
    },
  };
}
