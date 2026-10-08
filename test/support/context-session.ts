import { type SessionBoundaryDraft, SessionManager } from "@earendil-works/pi-coding-agent";

import { context, emit } from "./extension-fixture.js";

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
    details?: Record<string, unknown>,
  ): string {
    return this.manager.appendMessage({
      role: "toolResult",
      toolCallId: callId,
      toolName,
      content: typeof content === "string" ? [{ type: "text", text: content }] : content,
      isError: false,
      timestamp: Date.now(),
      ...(details ? { details: details as never } : {}),
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

/** Appends boundary drafts with the same session-manager calls Pi's boundary commit uses. */
export function applyBoundary(manager: SessionManager, drafts: SessionBoundaryDraft[]): void {
  for (const draft of drafts) {
    if (draft.type === "custom") manager.appendCustomEntry(draft.customType, draft.data);
    else if (draft.type === "custom_message") {
      manager.appendCustomMessageEntry(
        draft.customType,
        draft.content,
        draft.display,
        draft.details,
      );
    } else if (draft.type === "context_edit") {
      manager.appendContextEdit(draft.targetId, draft.replacement);
    }
  }
}

/**
 * Ends the agent run as Pi does: runs `agent_before_settle` handlers and commits the entries
 * they return.
 */
export async function settleRun(
  session: SessionBuilder,
  options: { ctx?: Record<string, unknown> } = {},
): Promise<SessionBoundaryDraft[]> {
  const results = await emit(
    "agent_before_settle",
    {
      type: "agent_before_settle",
      entries: [],
      continue: false,
      context: {},
      outcome: "completed",
    },
    context({ sessionManager: session.manager, ...options.ctx }),
  );
  const returned = results.find(Boolean) as { entries?: SessionBoundaryDraft[] } | undefined;
  const entries = returned?.entries ?? [];
  applyBoundary(session.manager, entries);
  return entries;
}

export interface EndTurnOptions {
  isError?: boolean;
  outcome?: "completed" | "aborted" | "error";
  /** Entries earlier boundary handlers proposed. */
  entries?: SessionBoundaryDraft[];
  ctx?: Record<string, unknown>;
}

/**
 * Finishes the harness tool call's turn as Pi does: persists its result, runs `turn_end`
 * handlers, and commits the entries they return. The run continues; use endRun() for its last
 * turn.
 */
export async function endTurn(
  session: SessionBuilder,
  options: EndTurnOptions = {},
): Promise<SessionBoundaryDraft[]> {
  const isError = options.isError ?? false;
  session.result("call-id", "typescript", isError ? "failed" : "ok");
  const results = await emit(
    "turn_end",
    {
      type: "turn_end",
      turnIndex: 0,
      message: {},
      toolResults: [
        {
          role: "toolResult",
          toolCallId: "call-id",
          toolName: "typescript",
          content: [],
          isError,
          timestamp: 0,
        },
      ],
      messageEntryId: "",
      toolResultEntryIds: [],
      entries: options.entries ?? [],
      continue: false,
      context: {},
      outcome: options.outcome ?? "completed",
    },
    context({ sessionManager: session.manager, ...options.ctx }),
  );
  // Pit registers one turn_end handler; it returns nothing when it adds no entries.
  const returned = results.find(Boolean) as { entries?: SessionBoundaryDraft[] } | undefined;
  const entries = returned?.entries ?? options.entries ?? [];
  applyBoundary(session.manager, entries);
  return entries;
}

/**
 * Finishes the run's last turn as Pi does: ends the turn, then settles the run, which applies
 * deferred edits.
 */
export async function endRun(
  session: SessionBuilder,
  options: EndTurnOptions = {},
): Promise<SessionBoundaryDraft[]> {
  const entries = await endTurn(session, options);
  return [...entries, ...(await settleRun(session, options.ctx ? { ctx: options.ctx } : {}))];
}
