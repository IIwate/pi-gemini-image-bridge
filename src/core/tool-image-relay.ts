/**
 * Builds a transient request view that moves tool-result images into the
 * user-attachment channel used reliably by Responses-based Gemini proxies.
 */

const RESPONSE_RELAY_APIS = new Set([
  "openai-responses",
  "openai-codex-responses",
  "cliproxyapi-codex-responses",
]);

export const TOOL_IMAGE_RELAY_TEXT = "Attached image(s) from tool result:";
export const IMAGE_ONLY_TOOL_RESULT_TEXT = "(see attached image)";

export interface ImageModelDescriptor {
  id: string;
  api: string;
  input: readonly string[];
}

export interface RelayTextContent {
  type: "text";
  text: string;
}

export interface RelayImageContent {
  type: "image";
  mimeType: string;
  data: string;
}

export interface RelayedUserMessage {
  role: "user";
  content: (RelayTextContent | RelayImageContent)[];
  timestamp: number;
}

interface ToolResultView {
  record: Record<string, unknown>;
  content: unknown[];
  timestamp: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asToolResultView(value: unknown): ToolResultView | null {
  if (!isRecord(value) || value.role !== "toolResult" || !Array.isArray(value.content)) {
    return null;
  }

  return {
    record: value,
    content: value.content,
    timestamp: typeof value.timestamp === "number" ? value.timestamp : 0,
  };
}

function isImageContent(value: unknown): value is RelayImageContent {
  return (
    isRecord(value) &&
    value.type === "image" &&
    typeof value.mimeType === "string" &&
    typeof value.data === "string"
  );
}

export function isGeminiImageModel(
  model: ImageModelDescriptor | undefined,
): model is ImageModelDescriptor {
  return Boolean(
    typeof model?.id === "string" &&
      model.id.startsWith("gemini") &&
      Array.isArray(model.input) &&
      model.input.includes("image"),
  );
}

export function shouldRelayToolResultImages(model: ImageModelDescriptor | undefined): boolean {
  return isGeminiImageModel(model) && RESPONSE_RELAY_APIS.has(model.api);
}

/**
 * Keeps consecutive tool results together, then appends one transient user
 * attachment message for every tool-result batch that contained images.
 */
export function relayToolResultImages<T>(
  messages: readonly T[],
): Array<T | RelayedUserMessage> {
  const relayed: Array<T | RelayedUserMessage> = [];
  let index = 0;

  while (index < messages.length) {
    const firstToolResult = asToolResultView(messages[index]);
    if (!firstToolResult) {
      relayed.push(messages[index]);
      index++;
      continue;
    }

    const batchImages: RelayImageContent[] = [];
    let batchTimestamp = firstToolResult.timestamp;

    while (index < messages.length) {
      const original = messages[index];
      const toolResult = asToolResultView(original);
      if (!toolResult) break;

      const images = toolResult.content.filter(isImageContent);
      if (images.length === 0) {
        relayed.push(original);
      } else {
        const retainedContent = toolResult.content.filter((item) => !isImageContent(item));
        if (retainedContent.length === 0) {
          retainedContent.push({ type: "text", text: IMAGE_ONLY_TOOL_RESULT_TEXT });
        }

        relayed.push({ ...toolResult.record, content: retainedContent } as T);
        batchImages.push(...images);
      }

      batchTimestamp = toolResult.timestamp;
      index++;
    }

    if (batchImages.length > 0) {
      relayed.push({
        role: "user",
        content: [{ type: "text", text: TOOL_IMAGE_RELAY_TEXT }, ...batchImages],
        timestamp: batchTimestamp,
      });
    }
  }

  return relayed;
}
