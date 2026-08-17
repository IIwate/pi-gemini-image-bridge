/**
 * index.ts — Composition root: converts pasted clipboard images into user-message
 * attachments for Gemini-family models via a 4-tier adaptive pipeline with lazy worker
 * and session-scoped placeholder rehydration (D13).
 *
 * Why: CPA's gemini translator drops images inside functionResponse (read-tool
 * results), but translates user-message `input_image` parts correctly. Turning the
 * pasted image path into an attachment sends it through the working channel.
 *
 * Host knowledge lives here only: gates, Pi event wiring, and pipeline calls.
 * Core modules (src/core/) are pure and Pi-free.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { createAttachmentCache } from "./core/cache.ts";
import { createBudgetPool } from "./core/budget.ts";
import { buildTransform, placeholderTextFor, type ConvertedItem } from "./core/build.ts";
import { loadImageAdaptive } from "./core/load.ts";
import { scanClipboardImagePaths, scanPlaceholderTokens } from "./core/scan.ts";

export default function (pi: ExtensionAPI) {
  // Session-scoped in-memory cache for placeholder rehydration (decisions.md D13)
  const attachmentCache = createAttachmentCache(50);

  pi.on("session_shutdown", async () => {
    attachmentCache.clear();
  });

  pi.on("input", async (event, ctx) => {
    // Gates fail open (decisions.md D1/D2): non-gemini models and non-interactive
    // sources pass through untouched.
    if (!ctx.model?.id.startsWith("gemini")) return { action: "continue" };
    if (event.source !== "interactive") return { action: "continue" };

    const dropDir = tmpdir();
    const rawPaths = scanClipboardImagePaths(event.text, dropDir);
    const existingPlaceholders = scanPlaceholderTokens(event.text);

    // If text contains neither raw clipboard paths nor existing placeholders, pass through
    if (rawPaths.length === 0 && existingPlaceholders.length === 0) {
      return { action: "continue" };
    }

    // Collect all targets and sort them by appearance order in text
    interface ScanTarget {
      token: string;
      index: number;
      isPlaceholder: boolean;
    }

    const targets: ScanTarget[] = [];

    for (const p of rawPaths) {
      const idx = event.text.indexOf(p);
      if (idx !== -1) targets.push({ token: p, index: idx, isPlaceholder: false });
    }

    for (const ph of existingPlaceholders) {
      const idx = event.text.indexOf(ph);
      if (idx !== -1) targets.push({ token: ph, index: idx, isPlaceholder: true });
    }

    targets.sort((a, b) => a.index - b.index);

    // Dynamic greedy budget pool: 50MB raw binary ceiling (decisions.md D5 & D11)
    const budgetPool = createBudgetPool();
    const converted: ConvertedItem[] = [];
    let imageIndex = 0;

    for (const target of targets) {
      let resolvedPath: string | null = null;

      if (!target.isPlaceholder) {
        resolvedPath = target.token;
      } else {
        resolvedPath = attachmentCache.get(target.token) ?? null;
      }

      if (!resolvedPath || !existsSync(resolvedPath)) {
        // Cache miss or physical file deleted on disk (decisions.md D13)
        converted.push({
          target: target.token,
          label: "",
          image: null,
          placeholder: placeholderTextFor(target.isPlaceholder ? "missing-cache" : "unreadable"),
        });
        continue;
      }

      const result = await loadImageAdaptive(resolvedPath, budgetPool);

      if (result.ok) {
        imageIndex++;
        const annotationSuffix = result.annotation ? ` ${result.annotation}` : "";
        const label = `[Image #${imageIndex}${annotationSuffix}]`;
        const canonicalLabel = `[Image #${imageIndex}]`;

        // Record in session cache for future rehydration on rewind/abort
        attachmentCache.set(canonicalLabel, resolvedPath);
        if (annotationSuffix) {
          attachmentCache.set(label, resolvedPath);
        }

        converted.push({
          target: target.token,
          label,
          image: { type: "image", mimeType: result.image.mimeType, data: result.image.data },
          placeholder: "",
        });
      } else {
        converted.push({
          target: target.token,
          label: "",
          image: null,
          placeholder: placeholderTextFor(result.reason),
        });
      }
    }

    const built = buildTransform(event.text, event.images ?? [], converted);
    if (!built) return { action: "continue" };
    return { action: "transform", text: built.text, images: built.images };
  });
}
