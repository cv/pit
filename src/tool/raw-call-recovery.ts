import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { isProgramExpression } from "../functions/source.js";

// Pi's parseToolCallArguments keeps the complete provider input after this delimiter when JSON
// parsing fails. Never infer code from a valid JSON call or from a different tool/provider.
const RECEIVED_ARGUMENTS = "\n\nReceived arguments:\n";

interface RecoveredCall {
  id: string;
  code: string;
}

interface RecoveredMessage {
  message: AssistantMessage;
  calls: RecoveredCall[];
}

function recover(message: AssistantMessage): RecoveredMessage | undefined {
  if (message.api !== "openai-codex-responses" || message.stopReason !== "toolUse") return;
  const calls: RecoveredCall[] = [];
  const content = message.content.map((block) => {
    if (
      block.type !== "toolCall" ||
      block.name !== "typescript" ||
      !block.id.split("|")[1]?.startsWith("fc_") ||
      typeof block.argumentsError !== "string" ||
      Object.keys(block.arguments).length !== 0
    )
      return block;
    const marker = block.argumentsError.indexOf(RECEIVED_ARGUMENTS);
    if (marker < 0) return block;
    const code = block.argumentsError.slice(marker + RECEIVED_ARGUMENTS.length);
    // This only recognizes a function-shaped input; the sandbox still validates the program.
    if (!code.trim() || !isProgramExpression(code)) return block;
    calls.push({ id: block.id, code });
    const { argumentsError: _error, ...call } = block;
    return { ...call, arguments: { code } };
  });
  return calls.length === 0 ? undefined : { message: { ...message, content }, calls };
}

/** Repair before Pi validates and persists; repair old history only in the outgoing projection. */
export function registerRawCallRecovery(pi: ExtensionAPI): ReadonlyMap<string, string> {
  const recovered = new Map<string, string>();
  pi.on("session_start", () => recovered.clear());
  pi.on("session_tree", () => recovered.clear());
  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    const result = recover(event.message);
    if (!result) return;
    for (const call of result.calls) recovered.set(call.id, call.code);
    return { message: result.message };
  });
  pi.on("context", (event) => {
    let changed = false;
    const messages = event.messages.map((message) => {
      if (message.role !== "assistant") return message;
      const result = recover(message);
      if (!result) return message;
      changed = true;
      return result.message;
    });
    if (changed) return { messages };
  });
  return recovered;
}
