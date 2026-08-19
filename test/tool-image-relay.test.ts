/**
 * Tool image relay tests: ordering, aggregation, idempotence, and model gates with
 * zero Pi involvement (Unidirectional-Flow litmus test). Run with `node --test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  IMAGE_ONLY_TOOL_RESULT_TEXT,
  TOOL_IMAGE_RELAY_TEXT,
  isGeminiImageModel,
  relayToolResultImages,
  shouldRelayToolResultImages,
} from "../src/core/tool-image-relay.ts";

const TOOL_IMG_A = { type: "image" as const, mimeType: "image/png", data: "aW1hZ2UtYQ==" };
const TOOL_IMG_B = { type: "image" as const, mimeType: "image/jpeg", data: "aW1hZ2UtYg==" };

test("relay moves a read image after its tool result without mutating session messages", () => {
  const messages = [
    { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read" }], timestamp: 1 },
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text: "Read image file [image/png]" }, TOOL_IMG_A],
      isError: false,
      timestamp: 2,
    },
  ];
  const original = structuredClone(messages);

  const result = relayToolResultImages(messages);

  assert.deepEqual(messages, original);
  assert.equal(result.length, 3);
  assert.deepEqual(result[1], {
    ...messages[1],
    content: [{ type: "text", text: "Read image file [image/png]" }],
  });
  assert.deepEqual(result[2], {
    role: "user",
    content: [{ type: "text", text: TOOL_IMAGE_RELAY_TEXT }, TOOL_IMG_A],
    timestamp: 2,
  });
});

test("relay keeps parallel tool results ordered and aggregates all tool images once", () => {
  const first = {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "read",
    content: [{ type: "text", text: "first" }, TOOL_IMG_A],
    isError: false,
    timestamp: 10,
  };
  const second = {
    role: "toolResult",
    toolCallId: "call-2",
    toolName: "browser_screenshot",
    content: [{ type: "text", text: "second" }, TOOL_IMG_B],
    isError: false,
    timestamp: 11,
  };

  const result = relayToolResultImages([first, second]);

  assert.equal(result.length, 3);
  assert.equal(result[0].role, "toolResult");
  assert.equal(result[1].role, "toolResult");
  assert.deepEqual(result[2], {
    role: "user",
    content: [{ type: "text", text: TOOL_IMAGE_RELAY_TEXT }, TOOL_IMG_A, TOOL_IMG_B],
    timestamp: 11,
  });
});

test("relay preserves mixed text-only results and adds a placeholder for image-only results", () => {
  const textOnly = {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "read",
    content: [{ type: "text", text: "plain text" }],
    isError: false,
    timestamp: 20,
  };
  const imageOnly = {
    role: "toolResult",
    toolCallId: "call-2",
    toolName: "screenshot",
    content: [TOOL_IMG_A],
    isError: false,
    timestamp: 21,
  };

  const result = relayToolResultImages([textOnly, imageOnly]);

  assert.equal(result[0], textOnly);
  assert.deepEqual(result[1], {
    ...imageOnly,
    content: [{ type: "text", text: IMAGE_ONLY_TOOL_RESULT_TEXT }],
  });
  assert.deepEqual(result[2], {
    role: "user",
    content: [{ type: "text", text: TOOL_IMAGE_RELAY_TEXT }, TOOL_IMG_A],
    timestamp: 21,
  });
});

test("relay is idempotent and never duplicates Base64 image payloads", () => {
  const messages = [{
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "read",
    content: [{ type: "text", text: "image" }, TOOL_IMG_A, TOOL_IMG_B],
    isError: false,
    timestamp: 30,
  }];

  const once = relayToolResultImages(messages);
  const twice = relayToolResultImages(once);
  const imagePayloads = twice.flatMap((message) => {
    if (!("content" in message) || !Array.isArray(message.content)) return [];
    return message.content.flatMap((item) => (
      item.type === "image" && "data" in item && typeof item.data === "string" ? [item.data] : []
    ));
  });

  assert.deepEqual(twice, once);
  assert.deepEqual(imagePayloads, [TOOL_IMG_A.data, TOOL_IMG_B.data]);
});

test("model gates require Gemini image capability and a Responses relay API", () => {
  const cliproxyGemini = {
    id: "gemini-3.7-flash-high",
    api: "cliproxyapi-codex-responses",
    input: ["text", "image"],
  };

  assert.equal(isGeminiImageModel(cliproxyGemini), true);
  assert.equal(shouldRelayToolResultImages(cliproxyGemini), true);
  assert.equal(shouldRelayToolResultImages({ ...cliproxyGemini, api: "openai-responses" }), true);
  assert.equal(shouldRelayToolResultImages({ ...cliproxyGemini, api: "openai-codex-responses" }), true);
  assert.equal(shouldRelayToolResultImages({ ...cliproxyGemini, api: "openai-completions" }), false);
  assert.equal(shouldRelayToolResultImages({ ...cliproxyGemini, api: "google-generative-ai" }), false);
  assert.equal(shouldRelayToolResultImages({ ...cliproxyGemini, input: ["text"] }), false);
  assert.equal(shouldRelayToolResultImages({ ...cliproxyGemini, id: "claude-sonnet" }), false);
  assert.equal(isGeminiImageModel(undefined), false);
  assert.equal(isGeminiImageModel({ ...cliproxyGemini, input: undefined as never }), false);
  assert.equal(isGeminiImageModel({ ...cliproxyGemini, id: undefined as never }), false);
});
