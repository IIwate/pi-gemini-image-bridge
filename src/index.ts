/**
 * index.ts — Composition root: converts pasted clipboard images into user-message
 * attachments for Gemini-family models via a 4-tier adaptive pipeline with lazy worker,
 * stateless self-contained placeholders, and model-aware dual-track routing (D13).
 *
 * Why: CPA's gemini translator drops images inside functionResponse (read-tool
 * results), but translates user-message `input_image` parts correctly. Turning the
 * pasted image path into an attachment sends it through the working channel.
 *
 * For non-Gemini models (Claude/GPT), self-contained placeholders in rewound text are
 * seamlessly restored to local file paths without large Base64 attachments (protecting
 * Claude's strict 5MB API limit).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import {
  DEFAULT_MAX_REQUEST_BYTES,
  base64DecodedByteLength,
  createBudgetPool,
} from "./core/budget.ts";
import {
  buildTransform,
  placeholderTextFor,
  EXPIRED_PLACEHOLDER,
  type ConvertedItem,
} from "./core/build.ts";
import { loadImageAdaptive } from "./core/load.ts";
import {
  scanClipboardImagePaths,
  scanSelfContainedPlaceholders,
  extractFilename,
  type SelfContainedPlaceholderMatch,
} from "./core/scan.ts";

export default function (pi: ExtensionAPI) {
  pi.on("input", async (event, ctx) => {
    // Only intercept interactive user input (decisions.md D2)
    if (event.source !== "interactive") return { action: "continue" };

    const dropDir = tmpdir();
    const isGemini = ctx.model?.id?.startsWith("gemini") ?? false;
    const rawPaths = scanClipboardImagePaths(event.text, dropDir);
    const placeholders = scanSelfContainedPlaceholders(event.text);

    // If text contains neither raw paths nor self-contained placeholders, pass through
    if (rawPaths.length === 0 && placeholders.length === 0) {
      return { action: "continue" };
    }

    // -------------------------------------------------------------------------
    // Track B: Non-Gemini Models (Claude / GPT / Local Models)
    // -------------------------------------------------------------------------
    // Restore self-contained placeholders back to local file paths so non-Gemini
    // models can use their native read-tool. Zero Base64 attachments are injected,
    // strictly protecting Claude's 5MB API limit.
    if (!isGemini) {
      if (placeholders.length === 0) return { action: "continue" };

      let text = event.text;
      for (const ph of placeholders) {
        const physicalPath = join(dropDir, ph.filename);
        const replacement = existsSync(physicalPath) ? physicalPath : EXPIRED_PLACEHOLDER;
        text = text.replaceAll(ph.token, replacement);
      }
      return { action: "transform", text, images: event.images ?? [] };
    }

    // -------------------------------------------------------------------------
    // Track A: Gemini Models (4-Tier 100MB Adaptive Pipeline)
    // -------------------------------------------------------------------------
    interface TargetItem {
      token: string;
      filename: string;
      resolvedPath: string;
      index: number;
    }

    const targets: TargetItem[] = [];

    for (const p of rawPaths) {
      const idx = event.text.indexOf(p);
      if (idx !== -1) {
        targets.push({
          token: p,
          filename: extractFilename(p),
          resolvedPath: p,
          index: idx,
        });
      }
    }

    for (const ph of placeholders) {
      const idx = event.text.indexOf(ph.token);
      if (idx !== -1) {
        targets.push({
          token: ph.token,
          filename: ph.filename,
          resolvedPath: join(dropDir, ph.filename),
          index: idx,
        });
      }
    }

    targets.sort((a, b) => a.index - b.index);

    // Existing attachments and converted images share one request-level ceiling (D5 & D11)
    const existingImages = event.images ?? [];
    const reservedBytes = existingImages.reduce(
      (total, image) => total + base64DecodedByteLength(image.data),
      0,
    );
    const budgetPool = createBudgetPool(DEFAULT_MAX_REQUEST_BYTES, reservedBytes);
    const converted: ConvertedItem[] = [];
    let imageIndex = 0;

    for (const target of targets) {
      if (!existsSync(target.resolvedPath)) {
        converted.push({
          target: target.token,
          label: "",
          image: null,
          placeholder: placeholderTextFor("expired"),
        });
        continue;
      }

      const result = await loadImageAdaptive(target.resolvedPath, budgetPool);

      if (result.ok) {
        imageIndex++;
        const annotationSuffix = result.annotation ? ` ${result.annotation}` : "";
        // Self-contained label embeds the filename for stateless cross-session recovery
        const label = `[Image #${imageIndex}: ${target.filename}${annotationSuffix}]`;

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

    const built = buildTransform(event.text, existingImages, converted);
    if (!built) return { action: "continue" };
    return { action: "transform", text: built.text, images: built.images };
  });
}
