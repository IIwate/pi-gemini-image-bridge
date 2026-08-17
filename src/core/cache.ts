/**
 * cache.ts — Lightweight in-memory session attachment cache for placeholder rehydration.
 *
 * Maps emitted placeholder labels (e.g. "[Image #1]") to their on-disk clipboard file
 * paths (e.g. "/tmp/pi-clipboard-<uuid>.png").
 *
 * Implements S.U.P.E.R. Architecture & D13:
 * - Zero buffer overhead: holds string paths only, never resident image bytes.
 * - LRU bounded capacity: limits memory footprint to a fixed max size (default: 50).
 * - Pure data contract: zero Pi runtime dependencies.
 */

export interface AttachmentCache {
  get(label: string): string | undefined;
  set(label: string, filePath: string): void;
  has(label: string): boolean;
  clear(): void;
  size(): number;
}

export function createAttachmentCache(maxCapacity = 50): AttachmentCache {
  const map = new Map<string, string>();

  return {
    get(label: string): string | undefined {
      const normalized = normalizeLabel(label);
      const filePath = map.get(normalized);
      if (filePath) {
        // Refresh LRU order
        map.delete(normalized);
        map.set(normalized, filePath);
      }
      return filePath;
    },

    set(label: string, filePath: string): void {
      const normalized = normalizeLabel(label);
      if (map.has(normalized)) {
        map.delete(normalized);
      } else if (map.size >= maxCapacity) {
        const oldestKey = map.keys().next().value;
        if (oldestKey !== undefined) {
          map.delete(oldestKey);
        }
      }
      map.set(normalized, filePath);
    },

    has(label: string): boolean {
      return map.has(normalizeLabel(label));
    },

    clear(): void {
      map.clear();
    },

    size(): number {
      return map.size;
    },
  };
}

/**
 * Normalizes placeholder label by stripping transparent annotations.
 * E.g., "[Image #1 (auto-scaled to 2560px...)]" -> "[Image #1]"
 */
export function normalizeLabel(label: string): string {
  const match = /^\[Image #(\d+)(?:\s+[^\]]*)?\]$/i.exec(label.trim());
  if (match) {
    return `[Image #${match[1]}]`;
  }
  return label.trim();
}
