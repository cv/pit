import { SessionManager } from "@earendil-works/pi-coding-agent";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export interface ToolCallSpec {
  id?: string;
  name: string;
  args?: Record<string, unknown>;
}

type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; thinkingSignature?: string }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

/** Builds a real Pi session tree so tests exercise Pi's own projection and edit rules. */
export class SessionBuilder {
  readonly manager = SessionManager.inMemory("/tmp/pit-context-test");
  private nextCall = 1;

  user(text: string): string {
    return this.manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
  }

  assistant(
    text: string,
    calls: ToolCallSpec[] = [],
    extra: Block[] = [],
  ): { id: string; callIds: string[] } {
    const callIds = calls.map((call) => call.id ?? `call-${this.nextCall++}`);
    const content: Block[] = [
      ...extra,
      ...(text ? [{ type: "text" as const, text }] : []),
      ...calls.map((call, index) => ({
        type: "toolCall" as const,
        id: callIds[index] as string,
        name: call.name,
        arguments: call.args ?? {},
      })),
    ];
    const id = this.manager.appendMessage({
      role: "assistant",
      content,
      api: "anthropic-messages",
      provider: "anthropic",
      model: "test-model",
      usage,
      stopReason: calls.length > 0 ? "toolUse" : "stop",
      timestamp: Date.now(),
    } as never);
    return { id, callIds };
  }

  result(
    callId: string,
    toolName: string,
    content:
      | string
      | Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>,
  ): string {
    return this.manager.appendMessage({
      role: "toolResult",
      toolCallId: callId,
      toolName,
      content: typeof content === "string" ? [{ type: "text", text: content }] : content,
      isError: false,
      timestamp: Date.now(),
    });
  }

  /** One completed tool round trip: an assistant call and its result. */
  turn(
    toolName: string,
    output: string,
    args: Record<string, unknown> = {},
  ): { assistant: string; result: string; callId: string } {
    const { id, callIds } = this.assistant("", [{ name: toolName, args }]);
    const callId = callIds[0] as string;
    return { assistant: id, result: this.result(callId, toolName, output), callId };
  }

  /** The in-flight turn running the harness tool call (`call-id`). */
  current(name = "typescript"): string {
    return this.assistant("", [{ id: "call-id", name, args: { code: "async () => 1" } }]).id;
  }
}
