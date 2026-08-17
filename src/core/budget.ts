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

/**
 * Creates a greedy budget pool that allocates binary payload budget in order of request.
 */
export function createBudgetPool(totalBytes = DEFAULT_MAX_REQUEST_BYTES): BudgetPool {
  let remaining = totalBytes;

  return {
    get totalBytes() {
      return totalBytes;
    },
    get remainingBytes() {
      return remaining;
    },
    allocate(neededBytes: number): BudgetAllocation {
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
