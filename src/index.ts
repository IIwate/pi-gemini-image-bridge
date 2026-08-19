/**
 * index.ts - Composition root: relays Responses tool-result images into the
 * user-attachment channel for Gemini-family models.
 *
 * Why: Pi's `read` tool already produces native image toolResults, but a Responses
 * proxy such as CLIProxyAPI can drop images nested in `function_call_output` items
 * while translating top-level user `input_image` parts correctly. The relay runs on
 * the request-scoped `context` event, so session storage, UI, rewind, and model
 * switching stay fully Pi-native (decisions.md D14 & D16).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { relayToolResultImages, shouldRelayToolResultImages } from "./core/tool-image-relay.ts";

export default function (pi: ExtensionAPI) {
  pi.on("context", (event, ctx) => {
    if (!shouldRelayToolResultImages(ctx.model)) return;
    return { messages: relayToolResultImages(event.messages) };
  });
}
