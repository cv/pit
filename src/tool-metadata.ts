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
  "Before an anonymous typescript call, compare the workflow with recent calls and saved functions. Define or extend a parameterized named function as soon as work repeats, has reusable steps, or is likely to recur; reserve anonymous typescript calls for truly ad hoc work. Use @pit project JSDoc only for project persistence.",
  "In typescript, maintain one parameterized saved function per intent: reuse, replace, or extend the closest saved-function signature, and add input modes or compose existing functions instead of creating overlapping variants.",
  "Filter and summarize inside typescript; return counts, IDs, and bounded relevant excerpts—not complete files, HTTP bodies, search corpora, or session records. If truncated, narrow the query rather than enlarging it; use capabilities for external effects.",
] as const;

export const LABEL_DESCRIPTION = "TUI verb phrase; about 15 words is a guideline.";

export const CODE_DESCRIPTION =
  "Type-checked expression or named function definition. Use @pit project JSDoc for trusted persistence. Await capabilities, do not import; return JSON data.";

export const PARAMS_DESCRIPTION =
  "Optional JSON second argument for large patches, file contents, or quoted data; annotate its type.";

export const SAVE_ONLY_DESCRIPTION =
  "Validate and save a named top-level function without executing it; top-level params are not accepted.";

export function createToolDescription(maxOutputBytes: number): string {
  return [
    "Execute a contextually type-checked TypeScript expression in a fresh restricted process.",
    "",
    "CALLING CONTRACT — CHOOSE REUSE FIRST",
    "",
    "Use an anonymous function only for genuinely one-shot work. Prefer saved functions for recurring workflows:",
    "",
    "async ({ workspace, shell }) => {",
    "  const [file, status] = await Promise.all([",
    '    workspace.read("package.json", { format: "raw" }),',
    '    shell.execFile("git", ["status", "--short"]),',
    "  ]);",
    "  return { packageJson: JSON.parse(file.content), status };",
    "}",
    "",
    "Capabilities are async. Put large data in params, sequence mutations, and use Promise.allSettled for optional probes. Imports and host access are unavailable.",
    "",
    "REUSABLE AND COMPOSED FUNCTIONS",
    "",
    "Save functions aggressively; do not wait for exact repetition. Keep one named function per intent instead of creating overlapping variants. Named functions run immediately and save only after successful execution; saveOnly validates without running:",
    "",
    "async function runTests({ shell }, input: { coverage?: boolean } = {}) {",
    '  const args = input.coverage ? ["run", "coverage"] : ["test"];',
    '  return shell.execFile("npm", args, { raise: true });',
    "}",
    "",
    "Results include active saved-function signatures. Invoke runTests() or runTests({ coverage: true }); referenced dependencies are injected.",
    "Use saveOnly to define without running; omit top-level params.",
    "For trusted projects, a JSDoc summary plus @pit project persists a function; unmarked definitions remain session overrides.",
    "",
    "Add input modes or compose existing saved functions first. For example, publishChanges can call runValidation, then commit and push with shell.execFile.",
    "",
    "HASHED EDIT WORKFLOW",
    "",
    'workspace.read("src/file.ts") returns hashed lines and a revision. Edit with those anchors:',
    "",
    'workspace.edit("src/file.ts", {',
    '  revision: "revision-from-read",',
    '  changes: [{ kind: "replace", start: "12:abc12", content: "replacement" }],',
    "})",
    "",
    "Changes support replace/delete, insertBefore/insertAfter, and replaceFile/deleteFile. To create a file, use revision: null and replaceFile. After edits, discard every prior revision and anchor; batch changes or re-read, and never mutate the same file concurrently. On mismatch, re-read. Raw mode is for JSON. Missing offset means 1, missing totalLines means lines, and missing hasMore/truncated means false.",
    "",
    'Batch operations are { kind: "read", file, options? } or { kind: "edit", file, changes }; use one kind per batch.',
    "",
    "CAPABILITIES",
    "",
    ...capabilityDocumentation().flatMap((line) => [line, ""]),
    "Paths are relative to Pi cwd unless absolute. Output is limited to " +
      formatSize(maxOutputBytes) +
      ".",
  ].join("\n");
}
