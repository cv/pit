import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { isProgramExpression } from "../functions/source.js";
import type { ToolCallArgs } from "../renderers/typescript-tool-call.js";

// Pi's parseToolCallArguments keeps the complete provider input after this delimiter when JSON
// parsing fails. Never infer code from a valid JSON call or from a different tool/provider.
const RECEIVED_ARGUMENTS = "\n\nReceived arguments:\n";

/** The raw source of an OpenAI grammar call that arrived as a JSON function call, if any. */
function rawSource(block: AssistantMessage["content"][number]): string | undefined {
  if (
    block.type !== "toolCall" ||
    block.name !== "typescript" ||
    !block.id.split("|")[1]?.startsWith("fc_") ||
    typeof block.argumentsError !== "string" ||
    Object.keys(block.arguments).length !== 0
  )
    return;
  const marker = block.argumentsError.indexOf(RECEIVED_ARGUMENTS);
  if (marker < 0) return;
  const code = block.argumentsError.slice(marker + RECEIVED_ARGUMENTS.length);
  // This only recognizes a function-shaped input; the sandbox still validates the program.
  return isProgramExpression(code) ? code : undefined;
}

/** Returns a copy of the message with its raw calls repaired, reporting each one, or undefined. */
function recover(
  message: AssistantMessage,
  onRecovered?: (id: string, code: string) => void,
): AssistantMessage | undefined {
  if (message.api !== "openai-codex-responses" || message.stopReason !== "toolUse") return;
  let changed = false;
  const content = message.content.map((block) => {
    const code = rawSource(block);
    if (code === undefined || block.type !== "toolCall") return block;
    changed = true;
    onRecovered?.(block.id, code);
    const { argumentsError: _error, ...call } = block;
    return { ...call, arguments: { code } };
  });
  return changed ? { ...message, content } : undefined;
}

/** Repair before Pi validates and persists; repair old history only in the outgoing projection. */
export function registerRawCallRecovery(pi: ExtensionAPI): ReadonlyMap<string, string> {
  const recovered = new Map<string, string>();
  pi.on("session_start", () => recovered.clear());
  pi.on("session_tree", () => recovered.clear());
  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    const message = recover(event.message, (id, code) => recovered.set(id, code));
    return message && { message };
  });
  pi.on("context", (event) => {
    let changed = false;
    const messages = event.messages.map((message) => {
      const repaired = message.role === "assistant" ? recover(message) : undefined;
      if (repaired) changed = true;
      return repaired ?? message;
    });
    if (changed) return { messages };
  });
  return recovered;
}

/**
 * Pi never refreshes a streamed row's arguments after `message_end` replaces the call, so the row
 * still holds the empty, stale arguments. Show the recovered source unless the row has its own.
 */
export function withRecoveredSource(
  sources: ReadonlyMap<string, string>,
  toolCallId: string,
  args: ToolCallArgs | null | undefined,
): ToolCallArgs | null | undefined {
  const code = sources.get(toolCallId);
  return code === undefined || (args && Object.hasOwn(args, "code")) ? args : { code };
}
