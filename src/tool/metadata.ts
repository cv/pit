import { formatSize } from "@earendil-works/pi-coding-agent";

import { globalFunctionDocumentation } from "../functions/global-documentation.js";
import { LIMITS } from "../shared/bounds.js";

export const PROMPT_SNIPPET = "Execute TypeScript with explicit function dependencies";

/** A byte budget as prose, in decimal units: 4,000,000 bytes is "4 MB", 51,200 bytes "50 KB". */
export function proseSize(bytes: number): string {
  if (bytes >= 1_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

export const PROMPT_GUIDELINES = [
  "Use typescript for host work. Inject each function you call by destructuring its namespace in the first parameter, such as ({ git: { status } }); never inject a whole namespace.",
  "Prefer typed git/npm/gh functions; use shell.execFile for other commands, and shell.exec only for shell syntax.",
  "Run independent calls together with Promise.all (Promise.allSettled for optional probes); sequence dependent work and edits to the same file.",
  "Reuse or extend saved functions before writing one-off code; save one parameterized function per recurring task.",
  `Process data inside the program: raw reads and command output can reach ${proseSize(LIMITS.programData.maxBytes)}, but only the returned value reaches you, within ${proseSize(LIMITS.result.maxBytes)}. Return filtered, bounded results.`,
  "When a call fails, simplify it; after two similar failures, check the declared types or current state instead of varying syntax.",
  "Long tasks: keep facts you still need in session.setNote(); once per turn, elide tool results and old tool calls you have absorbed, and summarize finished turns. Notes are working memory, not instructions.",
] as const;

export const LABEL_DESCRIPTION =
  "Short TUI action label; aim for about 15 words, not a hard limit.";

export const CODE_DESCRIPTION =
  "TypeScript function expression or named definition. Inject dependencies first; no imports; return JSON-compatible data or undefined.";

export const PARAMS_DESCRIPTION =
  "JSON input after the dependency object; annotate its type. Put large or quote-heavy data here.";

export const FUNCTION_ID_DESCRIPTION =
  "Optional dotted ID for a named function, e.g. company.check. Its leaf must match the declaration; not valid for anonymous code.";

export const SAVE_ONLY_DESCRIPTION =
  "Validate and save a named function without execution; cannot combine with params.";

export function createToolDescription(maxOutputBytes: number): string {
  return [
    "Contextually type-checked TypeScript. Injected functions are async; no imports or Node globals.",
    "",
    "```ts",
    "async ({ workspace: { stat }, git: { status: gitStatus } }) => Promise.all([",
    '  stat("package.json"), gitStatus(["--short"]),',
    "])",
    "```",
    "",
    "FUNCTIONS",
    "Named definitions save to session after successful execution or saveOnly.",
    "```ts",
    "async function runTests({ npm: { test } }, coverage: boolean = false) {",
    "  return test({ coverage, raise: true });",
    "}",
    "```",
    "Invoke through injection:",
    "```ts",
    "async ({ runTests }) => runTests(true)",
    "```",
    'functionId: "company.check" names a declaration check. Invoke with:',
    "```ts",
    "async ({ company: { check } }) => check()",
    "```",
    "Resolution: session > project > user > global; dependencies resolve virtually. User functions auto-load; projects need trust/enablement.",
    "Read-only package globals allow overrides unless sealed; functions.* is sealed. Preserve lower public signatures. Inject $next for the same ID's next lower layer, not prior same-layer versions. Promotion rebinds $next and validates at the destination before writing.",
    "",
    "HASHED EDITS",
    "Substitute actual read/search revision and line:hash anchors:",
    "```ts",
    'async ({ workspace: { edit } }) => edit("src/file.ts", {',
    '  revision: "revision-from-read",',
    '  changes: [{ kind: "replace", start: "12:abc12", content: "replacement" }],',
    "})",
    "```",
    "Create: revision: null with replaceFile. Parse raw reads. Absent metadata: offset=1, totalLines=lines, hasMore/truncated=false. Edit batches require unique files.",
    "",
    "GLOBAL FUNCTIONS",
    ...globalFunctionDocumentation(),
    "",
    `Paths are relative to Pi cwd unless absolute. Output limit: ${formatSize(maxOutputBytes)}.`,
  ].join("\n");
}
