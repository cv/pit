import { stripVTControlCharacters } from "node:util";

import type { AssistantMessage, Message, Model, ToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  cleanupHarness,
  context,
  emit,
  renderToolCall,
  renderToolResult,
  sessionStart,
  setupHarness,
  tool,
} from "../support/extension-fixture.js";

type FixtureMessage = AssistantMessage & { content: [ToolCall, ...ToolCall[]] };
const raw = 'async ({ git: { status } }) => status(["--short"])\n';

function malformed(code = raw): FixtureMessage {
  return {
    role: "assistant",
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "gpt-6.1-terra",
    stopReason: "toolUse",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: 0,
    content: [
      {
        type: "toolCall",
        id: "call_1|fc_1",
        name: "typescript",
        arguments: {},
        argumentsError: `Unexpected token 'a'\n\nReceived arguments:\n${code}`,
      },
    ],
  };
}

function messageReplacement(results: unknown[]): FixtureMessage {
  const value = results.find(
    (entry): entry is { message: FixtureMessage } =>
      typeof entry === "object" && entry !== null && "message" in entry,
  );
  if (!value) throw new Error("Expected a replacement assistant message");
  return value.message;
}

function contextReplacement(results: unknown[]): Message[] {
  const value = results.find(
    (entry): entry is { messages: Message[] } =>
      typeof entry === "object" && entry !== null && "messages" in entry,
  );
  if (!value) throw new Error("Expected a replacement context");
  return value.messages;
}

function firstToolCall(message: Message | undefined): ToolCall {
  if (message?.role !== "assistant") throw new Error("Expected an assistant message");
  const call = message?.content[0];
  if (call?.type !== "toolCall") throw new Error("Expected a TypeScript tool call");
  return call;
}

describe("raw grammar call recovery", () => {
  beforeEach(setupHarness);
  afterEach(cleanupHarness);

  it("repairs complete raw source before validation and replay", async () => {
    const message = malformed();
    const results = await emit("message_end", { type: "message_end", message }, context());
    const replacement = messageReplacement(results);
    expect(replacement.content[0].arguments).toEqual({ code: raw });
    expect(replacement.content[0].argumentsError).toBeUndefined();
    expect(message.content[0].arguments).toEqual({});
  });

  it("shows the recovered source when Pi's streaming row has stale arguments", async () => {
    await emit("message_end", { type: "message_end", message: malformed() }, context());
    const rendered = renderToolCall(
      {},
      { toolCallId: "call_1|fc_1", argsComplete: true, expanded: true },
    );
    expect(rendered).toContain("status([");
    expect(rendered).toContain("--short");
  });

  it("shows the recovered source in the expanded result despite stale streaming args", async () => {
    await emit("message_end", { type: "message_end", message: malformed() }, context());
    const rendered = renderToolResult(
      { content: [{ type: "text", text: "4" }], details: { value: 4 } },
      { expanded: true, isPartial: false },
      { toolCallId: "call_1|fc_1", args: {} },
    );
    expect(rendered).toContain("status([");
    expect(rendered).toContain("--short");
  });

  it("never overrides valid renderer inputs and clears recovered sources on session change", async () => {
    await emit("message_end", { type: "message_end", message: malformed() }, context());
    const ctx = { toolCallId: "call_1|fc_1", argsComplete: true, expanded: true };
    expect(renderToolCall({ code: 'async () => "new input"' }, ctx)).toContain("new input");
    await sessionStart({}, context());
    expect(renderToolCall({}, ctx)).not.toContain("--short");
  });

  it("clears recovered display inputs when navigating the session tree", async () => {
    const ctx = context();
    const renderContext = { toolCallId: "call_1|fc_1", argsComplete: true, expanded: true };
    await emit("message_end", { type: "message_end", message: malformed() }, ctx);
    expect(renderToolCall({}, renderContext)).toContain("--short");
    await emit("session_tree", { type: "session_tree" }, ctx);
    expect(renderToolCall({}, renderContext)).not.toContain("--short");
  });

  it("preserves an explicit empty source instead of showing recovered code", async () => {
    await emit("message_end", { type: "message_end", message: malformed() }, context());
    const renderContext = { toolCallId: "call_1|fc_1", argsComplete: true, expanded: true };
    const call = renderToolCall({ code: "" }, renderContext);
    const result = renderToolResult(
      { content: [{ type: "text", text: "invalid source" }], details: {} },
      { expanded: true, isPartial: false },
      { ...renderContext, args: { code: "" }, isError: true },
    );
    expect(call).toContain("(empty source)");
    expect(result).toContain("(empty source)");
    expect(call).not.toContain("--short");
    expect(result).not.toContain("--short");
  });

  it("does not display stale streaming fields as part of a recovered call", async () => {
    await emit("message_end", { type: "message_end", message: malformed() }, context());
    const stale = { label: "STALE LABEL", params: { file: "STALE FILE" } };
    const renderContext = { toolCallId: "call_1|fc_1", argsComplete: true, expanded: true };
    const call = stripVTControlCharacters(renderToolCall(stale, renderContext));
    const result = stripVTControlCharacters(
      renderToolResult(
        { content: [{ type: "text", text: "4" }], details: { value: 4 } },
        { expanded: true, isPartial: false },
        { ...renderContext, args: stale },
      ),
    );
    expect(call).toContain("--short");
    expect(result).toContain("--short");
    expect(call).not.toContain("STALE LABEL");
    expect(result).not.toContain("STALE FILE");
  });

  it("keeps distinct recovered sources associated with their own tool calls", async () => {
    const message = malformed();
    const other: ToolCall = {
      type: "toolCall",
      id: "call_2|fc_2",
      name: "typescript",
      arguments: {},
      argumentsError: "Unexpected token a\n\nReceived arguments:\nasync () => 'SECOND_SOURCE'",
    };
    message.content.push(other);
    const results = await emit("message_end", { type: "message_end", message }, context());
    const replacement = messageReplacement(results);
    expect(
      replacement.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : [])),
    ).toEqual(["call_1|fc_1", "call_2|fc_2"]);
    const first = renderToolCall(
      {},
      { toolCallId: "call_1|fc_1", argsComplete: true, expanded: true },
    );
    const second = renderToolCall(
      {},
      { toolCallId: "call_2|fc_2", argsComplete: true, expanded: true },
    );
    expect(first).toContain("--short");
    expect(first).not.toContain("SECOND_SOURCE");
    expect(second).toContain("SECOND_SOURCE");
    expect(second).not.toContain("--short");
  });

  it("recovers a raw call with an @pit options line before argument preparation", async () => {
    const rawWithOptions =
      '// @pit: {"label":"Inspect data","params":{"n":2}}\nasync ({}, input: { n: number }) => input.n\n';
    const message = malformed(rawWithOptions);
    const results = await emit("message_end", { type: "message_end", message }, context());
    const replacement = messageReplacement(results);
    expect(replacement.content[0].arguments).toEqual({ code: rawWithOptions });
    expect(tool.prepareArguments?.(replacement.content[0].arguments)).toEqual({
      code: "\nasync ({}, input: { n: number }) => input.n\n",
      label: "Inspect data",
      params: { n: 2 },
    });
  });

  it("displays recovered @pit options as the actual label and inputs", async () => {
    const message = malformed(
      '// @pit: {"label":"Inspect data","params":{"n":2}}\nasync ({}, input: { n: number }) => input.n\n',
    );
    await emit("message_end", { type: "message_end", message }, context());
    const renderContext = { toolCallId: "call_1|fc_1", argsComplete: true, expanded: true };
    const callView = renderToolCall({}, renderContext);
    const resultView = renderToolResult(
      { content: [{ type: "text", text: "2" }], details: { value: 2 } },
      { expanded: true, isPartial: false },
      { ...renderContext, args: {} },
    );
    expect(callView.split("\n")[0]).toContain("Inspect data");
    expect(resultView).toContain("Params");
    expect(stripVTControlCharacters(resultView)).toContain('"n": 2');
  });

  it("keeps malformed recovered @pit options inspectable without hiding the preparation error", async () => {
    const code = "// @pit: {bad}\nasync () => 2\n";
    const message = malformed(code);
    await emit("message_end", { type: "message_end", message }, context());
    const view = renderToolCall(
      {},
      { toolCallId: "call_1|fc_1", argsComplete: true, expanded: true },
    );
    expect(stripVTControlCharacters(view)).toContain("// @pit: {bad}");
    expect(() => tool.prepareArguments?.({ code })).toThrow("must hold a JSON object");
  });

  it("leaves non-assistant message events untouched", async () => {
    const message: Message = { role: "user", content: "user text", timestamp: 0 };
    expect(await emit("message_end", { type: "message_end", message }, context())).toEqual([
      undefined,
    ]);
  });

  it("preserves unrelated user messages and assistant text during history repair", async () => {
    const user: Message = { role: "user", content: "user text", timestamp: 0 };
    const original = malformed();
    const assistant: AssistantMessage = {
      ...original,
      content: [{ type: "text", text: "assistant text" }, original.content[0]],
    };
    const results = await emit(
      "context",
      { type: "context", messages: [user, assistant] },
      context(),
    );
    const replacement = contextReplacement(results);
    expect(replacement[0]).toEqual(user);
    expect(replacement[1]).toMatchObject({
      role: "assistant",
      content: [
        { type: "text", text: "assistant text" },
        { type: "toolCall", arguments: { code: raw } },
      ],
    });
    expect(assistant.content[1]).toMatchObject({ arguments: {} });
  });

  it("repairs existing history only in the provider projection", async () => {
    const message = malformed();
    const results = await emit("context", { type: "context", messages: [message] }, context());
    const replacement = contextReplacement(results);
    expect(firstToolCall(replacement[0]).arguments).toEqual({ code: raw });
    expect(message.content[0].arguments).toEqual({});
    expect(message.content[0].argumentsError).toContain("Received arguments:");
  });

  it("replays a recovered call through Pi's OpenAI grammar serializer", async () => {
    const { convertResponsesMessages } =
      await import("../../node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js");
    const { normalizeContext } =
      await import("../../node_modules/@earendil-works/pi-ai/dist/utils/transcript.js");
    const message = malformed();
    const results = await emit("context", { type: "context", messages: [message] }, context());
    const replacement = contextReplacement(results);
    const model: Model<"openai-codex-responses"> = {
      id: "gpt-6.1-terra",
      name: "Terra fixture",
      api: "openai-codex-responses",
      provider: "openai-codex",
      baseUrl: "http://127.0.0.1",
      input: ["text"],
      reasoning: false,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100000,
      maxTokens: 4096,
    };
    const request = convertResponsesMessages(
      model,
      normalizeContext({ messages: replacement }),
      new Set(["openai-codex"]),
      {
        grammarToolInputProperties: new Map([["typescript", "code"]]),
      },
    );
    expect(request).toContainEqual(
      expect.objectContaining({ type: "custom_tool_call", name: "typescript", input: raw }),
    );
  });

  it.each<[string, (message: FixtureMessage) => void]>([
    [
      "truncated response",
      (m: FixtureMessage) => {
        m.stopReason = "length";
      },
    ],
    [
      "other provider API",
      (m: FixtureMessage) => {
        m.api = "openai-responses";
      },
    ],
    [
      "other tool",
      (m: FixtureMessage) => {
        m.content[0].name = "other";
      },
    ],
    [
      "custom call",
      (m: FixtureMessage) => {
        m.content[0].id = "call_1|ctc_1";
      },
    ],
    [
      "nonempty parsed fields even with a parse error",
      (m: FixtureMessage) => {
        m.content[0].arguments = { params: { n: 2 } };
      },
    ],
    [
      "empty arguments without a parse error",
      (m: FixtureMessage) => {
        delete m.content[0].argumentsError;
      },
    ],

    [
      "valid arguments",
      (m: FixtureMessage) => {
        m.content[0].arguments = { code: raw };
        delete m.content[0].argumentsError;
      },
    ],
    [
      "malformed JSON object",
      (m: FixtureMessage) => {
        m.content[0].argumentsError = 'bad\n\nReceived arguments:\n{"code":';
      },
    ],
    [
      "missing original input",
      (m: FixtureMessage) => {
        m.content[0].argumentsError = "bad";
      },
    ],
  ])("does not rewrite %s", async (_name, change) => {
    const message = malformed();
    change(message);
    expect(await emit("message_end", { type: "message_end", message }, context())).toEqual([
      undefined,
    ]);
  });
});
