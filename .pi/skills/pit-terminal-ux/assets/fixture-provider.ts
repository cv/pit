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
  "trace-a": { label: "TRACE A: simple value", code: "async ({}) => 42" },
  "trace-b": {
    label: "TRACE B: one file",
    code: 'async ({ workspace: { read } }) => read(".gitignore")',
  },
  "trace-c": {
    label: "TRACE C: two files",
    code: 'async ({ workspace: { read } }) => Promise.all([read(".gitignore"), read(".oxfmtrc.json")])',
  },
  "trace-d": {
    label: "TRACE D: bc sum",
    code: "async ({ shell: { exec } }) => exec(\"printf '2 + 3\\\\n' | bc\", { raise: true })",
  },
  "trace-e": {
    label: "TRACE E: wc then bc",
    code: `async ({ shell: { execFile, exec } }) => {
      const counts = await Promise.all([".gitignore", ".oxfmtrc.json"].map(async file => {
        const result = await execFile("wc", ["-l", file], { raise: true });
        const lines = Number(result.stdout.trim().split(/\\s+/)[0]);
        if (result.truncated || !Number.isSafeInteger(lines) || lines < 0) throw new Error("Invalid wc output");
        return { file, lines };
      }));
      const sum = await exec("printf '" + counts.map(item => item.lines).join(" + ") + "\\\\n' | bc", { raise: true });
      return { counts, sum };
    }`,
  },
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
  calls: {
    label: "UX CALLS: more call groups than the live budget",
    code: 'async ({ workspace: { stat, list }, shell: { execFile } }, input: { rounds: number; script: string }) => { for (let round = 0; round < input.rounds; round++) { await stat("package.json"); await list("src"); } return execFile("node", ["--input-type=module", "--eval", input.script], { timeoutMs: 15000 }); }',
    params: {
      rounds: 30,
      script:
        "for(let n=1;n<=6;n++){console.log('CALLS_STEP_'+n);await new Promise(r=>setTimeout(r,800));}",
    },
    timeoutMs: 20000,
  },
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
  "npm-pack": {
    label: "UX NPM PACK: real JSON dry run",
    code: "async ({ npm: { pack } }) => pack({ dryRun: true, timeoutMs: 60000 })",
    timeoutMs: 70000,
  },
  // Registry-backed npm commands return fixed reports without a network request. The never-taken
  // `npm.<method>()` branch lets result routing identify the capability from source.
  "npm-audit": {
    label: "UX NPM AUDIT: synthetic report",
    code: "async ({ npm: { audit } }, result: { stdout: string; stderr: string; code: number; truncated: boolean }) => { const npm = { audit }; return result.code < 0 ? npm.audit() : result; }",
    params: {
      stdout: JSON.stringify({
        auditReportVersion: 2,
        vulnerabilities: {
          "make-dir": {
            severity: "moderate",
            via: ["semver"],
            range: "2.0.0 - 3.1.0",
            fixAvailable: false,
          },
          semver: {
            severity: "moderate",
            via: [
              {
                title: "semver vulnerable to Regular Expression Denial of Service",
                url: "https://github.com/advisories/AUDIT_URL_SENTINEL",
              },
            ],
            range: "<5.7.2 || >=6.0.0 <6.3.1 || >=7.0.0 <7.5.2",
            fixAvailable: { name: "eslint", version: "9.0.0", isSemVerMajor: true },
          },
          "@babel/traverse": {
            severity: "critical",
            via: [
              {
                title:
                  "Babel vulnerable to arbitrary code execution when compiling specifically crafted malicious code",
              },
            ],
            range: "<7.23.2",
            fixAvailable: true,
          },
        },
        metadata: {
          vulnerabilities: { info: 0, low: 0, moderate: 2, high: 0, critical: 1, total: 3 },
        },
      }),
      stderr: "",
      code: 1,
      truncated: false,
    },
  },
  "npm-outdated": {
    label: "UX NPM OUTDATED: synthetic report",
    code: "async ({ npm: { outdated } }, result: { stdout: string; stderr: string; code: number; truncated: boolean }) => { const npm = { outdated }; return result.code < 0 ? npm.outdated() : result; }",
    params: {
      stdout: JSON.stringify({
        esbuild: { wanted: "0.28.2", latest: "0.28.2", dependent: "pit" },
        oxfmt: {
          current: "0.67.0",
          wanted: "0.68.0",
          latest: "0.70.0",
          dependent: "OUTDATED_SENTINEL",
        },
        typescript: { current: "6.0.2", wanted: "6.0.3", latest: "7.0.2", dependent: "pit" },
      }),
      stderr: "",
      code: 1,
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
