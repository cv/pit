import { formatSize } from "@earendil-works/pi-coding-agent";
import { capabilityDocumentation } from "./capability-registry.js";

export const PROMPT_SNIPPET =
  "Run sandboxed TypeScript with batched and parallel host capabilities plus reusable functions";

export const PROMPT_GUIDELINES = [
  "Use typescript for all workspace, shell, HTTP, UI, and context operations.",
  "In typescript, code is type-checked. Before fanning out an unfamiliar capability, validate one minimal call. After two failures of the same class, stop varying syntax: inspect contract/state, reduce to a minimal probe, and choose a simpler API if available.",
  "In typescript, prefer one tool invocation per step: batch independent calls with Promise.all instead of issuing multiple parallel typescript calls; sequence dependencies and conflicting mutations.",
  "In typescript, request only the fields and record limits needed to answer the current question; expand the query only when the first result requires it.",
  "Before editing in typescript, obtain the current revision and hashed anchors with workspace.read or workspace.search. A successful edit invalidates every prior revision and anchor for that file; batch compatible changes against one revision or re-read before the next edit, never mutate the same file concurrently, and re-read after a mismatch.",
  "Before an anonymous typescript call, compare the workflow with recent calls and saved functions. Define or extend a parameterized named function as soon as work repeats, has reusable steps, or is likely to recur; reserve anonymous typescript calls for truly ad hoc work. Use @pit project JSDoc only for intentional trusted-project persistence.",
  "In typescript, maintain one parameterized saved function per intent: reuse, replace, or extend the closest saved-function signature, and add input modes or compose existing functions instead of creating overlapping variants.",
  "Filter and summarize inside typescript; return counts, IDs, and bounded relevant excerpts—not complete files, HTTP bodies, search corpora, or session records. If truncated, narrow the query rather than enlarging it; use capabilities for external effects.",
] as const;

export const LABEL_DESCRIPTION =
  "Short concrete verb phrase describing the call in the TUI; about 15 words is a guideline, not a limit.";

export const CODE_DESCRIPTION =
  "Contextually type-checked TypeScript expression or named function definition. Await capabilities, do not import, and return a JSON-serializable value.";

export const PARAMS_DESCRIPTION =
  "Optional JSON input passed as the function second argument. Use it for large patches, file contents, or quote-heavy data; annotate the input parameter.";

export const SAVE_ONLY_DESCRIPTION =
  "Validate and save a named top-level function without executing it; top-level params are not accepted.";

export function createToolDescription(maxOutputBytes: number): string {
  return [
    "Execute a contextually type-checked TypeScript expression in a fresh restricted process.",
    "",
    "CALLING CONTRACT — CHOOSE REUSE FIRST",
    "",
    "Use an anonymous function only for genuinely one-shot work. Prefer named saved functions whenever work may recur or compose:",
    "",
    "async ({ workspace, shell }) => {",
    "  const [file, status] = await Promise.all([",
    '    workspace.read("package.json", { format: "raw" }),',
    '    shell.execFile("git", ["status", "--short"]),',
    "  ]);",
    "  return { packageJson: JSON.parse(file.content), status };",
    "}",
    "",
    "Capabilities are async. Put large data in top-level params, sequence dependencies and mutations, and use Promise.allSettled or local catches for optional probes. Imports and direct host access are unavailable.",
    "",
    "REUSABLE AND COMPOSED FUNCTIONS",
    "",
    "Save functions aggressively; do not wait for exact repetition. Keep one named function per intent: reuse, replace, or extend it for repeated, multi-step, or likely recurring work instead of creating overlapping variants. Named functions execute immediately and save only after successful execution; saveOnly: true validates without running:",
    "",
    "async function runTests({ shell }, input: { coverage?: boolean } = {}) {",
    '  const args = input.coverage ? ["run", "coverage"] : ["test"];',
    '  return shell.execFile("npm", args, { raise: true });',
    "}",
    "",
    "Results include active saved-function signatures. Invoke runTests() or runTests({ coverage: true }); only referenced definitions and dependencies are injected.",
    "To define now and invoke later, submit the named function with saveOnly: true and omit top-level params.",
    "For trusted projects, a JSDoc summary plus @pit project persists a function; unmarked same-named definitions remain session overrides.",
    "",
    "Add input modes or compose existing saved functions before creating another helper. For example, publishChanges can await runValidation(), then use shell.execFile for git add, commit, and push with { raise: true }.",
    "",
    "HASHED EDIT WORKFLOW",
    "",
    'workspace.read("src/file.ts") returns lines such as 12:abc12|content plus a revision. Use them in a later call:',
    "",
    'workspace.edit("src/file.ts", {',
    '  revision: "revision-from-read",',
    '  changes: [{ kind: "replace", start: "12:abc12", content: "replacement" }],',
    "})",
    "",
    "Changes: replace/delete with optional end, insertBefore/insertAfter, replaceFile/deleteFile. Create a missing file with revision: null and replaceFile. After success, discard every prior revision and anchor for that file; batch same-file changes or re-read, and never mutate the same file concurrently. On mismatch, re-read. Raw mode is for machine parsing. Missing offset means 1, missing totalLines means lines, and missing hasMore/truncated means false.",
    "",
    'Batch operations are { kind: "read", file, options? } or { kind: "edit", file, changes }. A batch must contain only reads or only edits and always returns { results }.',
    "",
    "CAPABILITIES",
    "",
    ...capabilityDocumentation().flatMap((line) => [line, ""]),
    "Paths are relative to Pi cwd unless absolute. Output is limited to " +
      formatSize(maxOutputBytes) +
      ".",
  ].join("\n");
}
