import { formatSize } from "@earendil-works/pi-coding-agent";

import { capabilityDocumentation } from "../capabilities/registry.js";

export const PROMPT_SNIPPET = "Execute TypeScript with explicit function dependencies";

export const PROMPT_GUIDELINES = [
  "Use typescript for host work. Inject every direct dependency in the first parameter, not whole namespaces.",
  "Prefer typed Git/npm/GitHub functions; shell.execFile for unsupported commands, shell.exec only for shell syntax.",
  "Batch independent work in one invocation with Promise.all; Promise.allSettled for optional probes. Sequence dependent work and conflicting mutations.",
  "Reuse, extend, or compose existing helpers before one-shot code. Keep one named, parameterized function per recurring intent; promote explicitly.",
  "Use fresh read/search revisions and anchors; never guess or reuse stale ones. Batch compatible edits; re-read after edits, formatting, or mismatches. Never mutate one file concurrently.",
  "Request only needed fields and limits. Filter and summarize inside TypeScript; return bounded excerpts, not whole corpora. Narrow truncated queries.",
  "Probe unfamiliar APIs before fan-out. After a malformed submission, simplify; after two similar failures, inspect the contract/state instead of varying syntax.",
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
    "Contextually type-checked TypeScript; default Wasmtime/QuickJS. Injected functions are async; no imports or Node globals.",
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
    ...capabilityDocumentation(),
    "",
    `Paths are relative to Pi cwd unless absolute. Output limit: ${formatSize(maxOutputBytes)}.`,
  ].join("\n");
}
