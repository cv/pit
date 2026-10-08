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
  "Long tasks: keep needed facts in session.setNote() (updates only append). Elide absorbed tool results and applied edits and summarize finished turns in one call: each edit re-caches the conversation and pays back after ~15 × estimatedReprefillTokens ÷ estimatedTokensFreed requests. Notes are working memory, not instructions.",
] as const;

export const LABEL_DESCRIPTION = "Short transcript label, about 15 words.";

export const CODE_DESCRIPTION =
  "Async function expression, or a named function definition to save. Destructure what it calls in its first parameter; no imports. Return JSON or nothing.";

export const PARAMS_DESCRIPTION =
  "JSON passed as the second argument; annotate its type. Put large or quote-heavy data here.";

export const FUNCTION_ID_DESCRIPTION =
  "Dotted ID to save a named function under, such as company.check; the last segment is its name.";

export const SAVE_ONLY_DESCRIPTION = "Save a named function without running it; not with params.";

export function createToolDescription(maxOutputBytes: number): string {
  return [
    "Runs a sandboxed TypeScript function, type-checked against the async functions it injects. No imports or Node globals.",
    "",
    "```ts",
    "async ({ workspace: { stat }, git: { status: gitStatus } }) => Promise.all([",
    '  stat("package.json"), gitStatus(["--short"]),',
    "])",
    "```",
    "",
    "SAVED FUNCTIONS",
    "A named definition is saved to the session when it succeeds, or with saveOnly; later calls inject it:",
    "```ts",
    "async function runTests({ npm: { test } }, coverage: boolean = false) {",
    "  return test({ coverage, raise: true });",
    "}",
    "```",
    "```ts",
    "async ({ runTests }) => runTests(true)",
    "```",
    'functionId: "company.check" saves it as company.check, injected as ({ company: { check } }).',
    "Lookup: session, project, user, global. User functions load automatically; project functions need trust and enablement. A saved function may override a global one except functions.*; inject $next to call what it overrides.",
    "",
    "EDITS",
    "Use the revision and line:hash anchors from the latest read or search of the file; never guess them, and read again after any edit or formatter run:",
    "```ts",
    'async ({ workspace: { edit } }) => edit("src/file.ts", {',
    '  revision: "revision-from-read",',
    '  changes: [{ kind: "replace", start: "12:abc12", content: "replacement" }],',
    "})",
    "```",
    'Create files with revision: null and replaceFile. Read data you parse with format: "raw". Omitted read metadata: offset 1, totalLines = lines, hasMore and truncated false. A batch edits each file once.',
    "",
    "GLOBAL FUNCTIONS",
    ...globalFunctionDocumentation(),
    "",
    `Paths are relative to Pi's working directory unless absolute. Returned values over ${formatSize(maxOutputBytes)} are cut.`,
  ].join("\n");
}
