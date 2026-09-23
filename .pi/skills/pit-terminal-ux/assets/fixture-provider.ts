/** Test-only offline provider for isolated Pi/tmux acceptance. Never load in a normal session. */
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type ToolCall,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function processFixture(label: string, script: string, timeoutMs = 5000, raise = false) {
  return {
    label,
    code: 'async ({ shell: { execFile } }, input: { script: string; timeoutMs: number; raise: boolean }) => execFile("node", ["--input-type=module", "--eval", input.script], { timeoutMs: input.timeoutMs, raise: input.raise })',
    params: { script, timeoutMs, raise },
    timeoutMs: Math.min(300000, timeoutMs + 5000),
  };
}
const fixtures: Record<string, ToolCall["arguments"]> = {
  transport: {},
  success: processFixture(
    "UX SUCCESS: separate streams",
    "console.log('STDOUT_SENTINEL'); console.error('STDERR_SENTINEL');",
  ),
  nested: {
    label: "UX NESTED: two process results",
    code: 'async ({ shell: { execFile } }, scripts: string[]) => { const [left, right] = await Promise.all(scripts.map(script => execFile("node", ["--eval", script], { timeoutMs: 5000 }))); return { left, right }; }',
    params: ["console.log('LEFT_SENTINEL');", "console.log('RIGHT_SENTINEL');"],
  },
  read: {
    label: "UX READ: explicit params",
    code: "async ({ workspace: { read } }, input: { file: string }) => read(input.file, { limit: 7 })",
    params: { file: "src/renderers/types.ts" },
    timeoutMs: 10000,
  },
  failure: processFixture(
    "UX FAILURE: intentional exit 2",
    "console.error('CAUSE_SENTINEL: intentional fixture failure'); process.exitCode=2;",
  ),
  error: {
    label: "UX ERROR: retained diagnostic tail",
    code: "async ({}, input: { message: string }) => { throw new Error(input.message); }",
    params: {
      message:
        Array.from({ length: 15 }, (_, i) => `Diagnostic line ${i + 1}`).join("\n") +
        "\nTAIL_SENTINEL: decisive final diagnostic",
    },
  },
  invalid: {
    label: "UX VALIDATION: not a timeout",
    code: "async ({}, input: { timeoutMs: number }) => input.timeoutMs.toUpperCase()",
    params: { timeoutMs: 5000 },
  },
  timeout: processFixture(
    "UX TIMEOUT: intentional deadline",
    "console.log('TIMEOUT_STARTED');setTimeout(()=>{},5000);",
    400,
    true,
  ),
  cancel: processFixture(
    "UX CANCEL: press Escape",
    "console.log('CANCEL_STARTED');console.log('CANCEL_PID:'+process.pid);setInterval(()=>console.log('CANCEL_TICK'),1000);",
    60000,
    true,
  ),
  progress: processFixture(
    "UX PROGRESS: live to settled",
    "for(let n=1;n<=6;n++){console.log('PROGRESS_STEP_'+n);await new Promise(r=>setTimeout(r,700));}",
    10000,
  ),
  batch: {
    label: "UX BATCH: one intentional read failure",
    code: 'async ({ workspace: { batch } }, input: { missing: string }) => batch([{ kind: "read", file: "src/renderers/types.ts", options: { limit: 2 } }, { kind: "read", file: input.missing }], { failure: "settled" })',
    params: { missing: `.pit-ux-missing-${Date.now()}` },
  },
  http: {
    label: "UX HTTP: synthetic error response",
    code: "async ({}, response: { status: number; ok: boolean; headers: Record<string, string>; body: string; truncated: boolean }) => response",
    params: {
      status: 503,
      ok: false,
      headers: { "content-type": "application/json" },
      body: '{"error":"HTTP_CAUSE_SENTINEL"}',
      truncated: false,
    },
  },
  json: {
    label: "UX JSON: nested multiline data",
    code: "async ({}, value: { identity: string; rows: { filename: string; patch: string; reviewed: boolean }[]; extra: string; flag: boolean }) => value",
    params: {
      identity: "RECORD_SENTINEL",
      rows: [
        { filename: "src/example.ts", patch: "-OLD_SENTINEL\n+NEW_SENTINEL", reviewed: false },
      ],
      extra: "EXTRA_SENTINEL",
      flag: false,
    },
  },
};
let sequence = 0;
export default function (pi: ExtensionAPI) {
  pi.registerProvider("pit-ux-fixture", {
    name: "Offline UX fixture",
    api: "pit-ux-fixture-api",
    baseUrl: "http://127.0.0.1:1",
    apiKey: "fixture-not-a-real-key",
    models: [
      {
        id: "fixture",
        name: "Offline UX fixture",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      },
    ],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const output: AssistantMessage = {
          role: "assistant",
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "pending",
          timestamp: Date.now(),
        };
        stream.push({ type: "start", partial: output });
        const last = context.messages
          .slice()
          .reverse()
          .find((message) => message.role !== "system");
        const text =
          last?.role === "user"
            ? typeof last.content === "string"
              ? last.content
              : last.content
                  .filter((block) => block.type === "text")
                  .map((block) => block.text)
                  .join("")
            : "";
        const name = text.trim();
        const fixture = Object.hasOwn(fixtures, name) ? fixtures[name] : undefined;
        if (name === "transport") {
          output.content.push({
            type: "toolCall",
            id: `ux-${++sequence}`,
            name: "typescript",
            arguments: {},
          });
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
          output.stopReason = "error";
          output.errorMessage =
            "FIXTURE_PROVIDER_STREAM_INTERRUPTED before arguments completed (no network request).";
          stream.push({ type: "error", reason: "error", error: output });
          stream.end();
          return;
        }
        if (fixture && !options?.signal?.aborted) {
          const block: ToolCall = {
            type: "toolCall",
            id: `ux-${++sequence}`,
            name: "typescript",
            arguments: {},
          };
          output.content.push(block);
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
          block.arguments = fixture;
          stream.push({
            type: "toolcall_delta",
            contentIndex: 0,
            delta: JSON.stringify(fixture),
            partial: output,
          });
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: block, partial: output });
          output.stopReason = "toolUse";
        } else {
          const content =
            last?.role === "toolResult"
              ? "Fixture completed."
              : `Available fixtures: ${Object.keys(fixtures).join(", ")}`;
          output.content.push({ type: "text", text: content });
          stream.push({ type: "text_start", contentIndex: 0, partial: output });
          stream.push({ type: "text_delta", contentIndex: 0, delta: content, partial: output });
          stream.push({ type: "text_end", contentIndex: 0, content, partial: output });
          output.stopReason = "stop";
        }
        stream.push({ type: "done", reason: output.stopReason, message: output });
        stream.end();
      });
      return stream;
    },
  });
}
