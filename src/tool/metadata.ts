import { formatSize } from "@earendil-works/pi-coding-agent";

import { capabilityDocumentation } from "../capabilities/registry.js";

export const PROMPT_SNIPPET =
  "Run sandboxed TypeScript with explicit, typed host and reusable function dependencies";

export const PROMPT_GUIDELINES = [
  "Use typescript for host operations.",
  "In typescript, inject individual methods in the first parameter instead of capturing a whole function namespace.",
  "In typescript, prefer git.status/diff/log/add/commit/show/push/tag for those Git subcommands; use shell.execFile only for other Git subcommands.",
  "In typescript, prefer npm.run/test/install/audit/outdated/pack and gh issue/pr/run/release methods for supported workflows; use shell.execFile only for unsupported commands.",
  "In typescript, code is type-checked. Before fanning out an unfamiliar function, validate one minimal call. After two failures of the same class, stop varying syntax: inspect contract/state, reduce to a minimal probe, and choose a simpler API if available.",
  "In typescript, prefer one tool invocation per step: batch independent calls with Promise.all instead of issuing multiple parallel typescript calls; sequence dependencies and conflicting mutations.",
  "In typescript, request only the fields and record limits needed to answer the current question; expand the query only when the first result requires it.",
  "Before editing in typescript, obtain the current revision and hashed anchors with workspace.read or workspace.search. A successful edit invalidates every prior revision and anchor for that file; batch compatible changes against one revision or re-read before the next edit, never mutate the same file concurrently, and re-read after a mismatch.",
  "Before an anonymous typescript call, compare recent work and available functions. Define or extend one parameterized named function when work repeats or is likely to recur; otherwise stay anonymous. Persist explicitly with functions.promote(name, summary) or /functions.",
  "In typescript, maintain one parameterized function per intent: reuse, replace, or extend the closest signature, and add input modes or compose existing functions instead of creating overlapping variants.",
  "Filter and summarize inside typescript; return counts, IDs, and bounded relevant excerpts—not complete files, HTTP bodies, search corpora, or session records. If truncated, narrow the query rather than enlarging it; use injected functions for external effects.",
] as const;

export const LABEL_DESCRIPTION =
  "Short concrete verb phrase describing the call in the TUI; about 15 words is a guideline, not a limit.";

export const CODE_DESCRIPTION =
  "Contextually type-checked TypeScript function expression or named function definition. Declare direct function dependencies in the first parameter, do not import, and return a JSON-serializable value.";

export const PARAMS_DESCRIPTION =
  "Optional JSON input passed after the injected dependency object. Use it for large patches, file contents, or quote-heavy data; annotate the input parameter.";

export const FUNCTION_ID_DESCRIPTION =
  "Optional dotted identifier for a named function, such as company.check. Its final segment must match the declaration name; anonymous functions cannot set it.";

export const SAVE_ONLY_DESCRIPTION =
  "Validate and save a named top-level function without executing it; top-level params are not accepted.";

export function createToolDescription(maxOutputBytes: number): string {
  return [
    "Run contextually type-checked TypeScript in an isolated executor.",
    "",
    "EXPLICIT FUNCTION DEPENDENCIES",
    "",
    "Declare every direct dependency in the first parameter. Inject individual methods, not whole namespaces:",
    "",
    "async ({ workspace: { read }, git: { status: gitStatus } }) => {",
    "  const [file, status] = await Promise.all([",
    '    read("package.json", { format: "raw" }),',
    '    gitStatus(["--short"]),',
    "  ]);",
    "  return { packageJson: JSON.parse(file.content), status };",
    "}",
    "",
    "Injected functions are async. Use Promise.all for required work and Promise.allSettled for optional probes. Sequence mutations, put large data in params, and do not import.",
    "",
    "REUSABLE AND COMPOSED FUNCTIONS",
    "",
    "Use an anonymous function only for genuinely one-shot work. Prefer named functions for work that can recur. A named function declares its own direct dependencies:",
    "",
    "async function runTests({ npm: { test } }, input: { coverage?: boolean } = {}) {",
    "  return test({ coverage: input.coverage, raise: true });",
    "}",
    "",
    "Use saveOnly: true to save without running. To call an available function, inject it explicitly: async ({ runTests }) => runTests({ coverage: true }). Extend or compose existing helpers.",
    "",
    'Set functionId: "company.check" for a named function check. Invoke it with async ({ company: { check } }) => check().',
    "",
    "Overrides must preserve lower call signatures. Named overrides can inject $next to call the next lower definition.",
    "",
    "HASHED EDIT WORKFLOW",
    "",
    'read("src/file.ts") returns 12:abc12|content plus a revision. Edit with:',
    "",
    'edit("src/file.ts", {',
    '  revision: "revision-from-read",',
    '  changes: [{ kind: "replace", start: "12:abc12", content: "replacement" }],',
    "})",
    "",
    "Inject workspace.read and workspace.edit as read and edit for this workflow. Use replace/delete, insertBefore/insertAfter, replaceFile, or deleteFile. After success, discard every prior revision and anchor; never mutate the same file concurrently.",
    "Raw reads support parsing. Missing offset means 1, missing totalLines means lines, and missing hasMore/truncated means false.",
    'Batch operations are { kind: "read", file, options? } or { kind: "edit", file, changes }; do not mix reads and edits.',
    "",
    "GLOBAL FUNCTIONS",
    "",
    ...capabilityDocumentation().flatMap((line) => [line, ""]),
    `Paths are relative to Pi cwd unless absolute. Output is limited to ${formatSize(maxOutputBytes)}.`,
  ].join("\n");
}
