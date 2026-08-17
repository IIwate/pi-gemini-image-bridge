/**
 * index.ts — Composition root: converts pasted clipboard images into user-message
 * attachments for Gemini-family models.
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
import { buildTransform, placeholderTextFor, type ConvertedItem } from "./core/build.ts";
import { loadImage } from "./core/load.ts";
import { scanClipboardImagePaths } from "./core/scan.ts";

export default function (pi: ExtensionAPI) {
  pi.on("input", async (event, ctx) => {
    // Gates fail open (decisions.md D1/D2): non-gemini models and non-interactive
    // sources pass through untouched.
    if (!ctx.model?.id.startsWith("gemini")) return { action: "continue" };
    if (event.source !== "interactive") return { action: "continue" };

    // Drop directory is platform-dependent (os.tmpdir()): /tmp on WSL, the user
    // Temp dir on Windows hosts.
    const paths = scanClipboardImagePaths(event.text, tmpdir());
    if (paths.length === 0) return { action: "continue" };

    const converted: ConvertedItem[] = [];
    for (let i = 0; i < paths.length; i++) {
      const label = `[Image #${i + 1}]`;
      const result = await loadImage(paths[i]);
      if (result.ok) {
        converted.push({
          path: paths[i],
          label,
          image: { type: "image", mimeType: result.image.mimeType, data: result.image.data },
          placeholder: "",
        });
      } else {
        converted.push({
          path: paths[i],
          label,
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
