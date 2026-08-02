import { formatSize } from "@earendil-works/pi-coding-agent";
import { capabilityDocumentation } from "./capability-registry.js";

export const PROMPT_SNIPPET =
  "Run sandboxed TypeScript with batched and parallel host capabilities plus reusable functions";

export const PROMPT_GUIDELINES = [
  "Use typescript for host operations.",
  "In typescript, prefer git.status/diff/log/add/commit/show/push/tag for those Git subcommands; use shell.execFile only for other Git subcommands.",
  "In typescript, prefer npm.run/test/install/audit/outdated/pack and gh issue/pr/run/release methods for supported workflows; use shell.execFile only for unsupported commands.",
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
    "Run contextually type-checked TypeScript in a fresh restricted process.",
    "",
    "CALLING CONTRACT — CHOOSE REUSE FIRST",
    "",
    "Use an anonymous function only for genuinely one-shot work. Prefer named functions for work that can recur:",
    "",
    "async ({ workspace, git }) => {",
    "  const [file, status] = await Promise.all([",
    '    workspace.read("package.json", { format: "raw" }),',
    '    git.status(["--short"]),',
    "  ]);",
    "  return { packageJson: JSON.parse(file.content), status };",
    "}",
    "",
    "Capabilities are async. Use Promise.all for required work and Promise.allSettled for optional probes. Sequence mutations, put large data in params, and do not import.",
    "",
    "REUSABLE AND COMPOSED FUNCTIONS",
    "",
    "Save functions aggressively; do not wait for exact repetition. Keep one named function per intent instead of creating overlapping variants; persist only after successful execution.",
    "",
    "async function runTests({ npm }, input: { coverage?: boolean } = {}) {",
    "  return npm.test({ coverage: input.coverage, raise: true });",
    "}",
    "",
    "Use saveOnly: true to save without running. Results include active saved-function signatures; invoke runTests({ coverage: true }). Add input modes or compose helpers. publishChanges can compose validation and Git.",
    "",
    "HASHED EDIT WORKFLOW",
    "",
    'workspace.read("src/file.ts") returns 12:abc12|content plus a revision. Edit with:',
    "",
    'workspace.edit("src/file.ts", {',
    '  revision: "revision-from-read",',
    '  changes: [{ kind: "replace", start: "12:abc12", content: "replacement" }],',
    "})",
    "",
    "Use replace/delete, insertBefore/insertAfter, replaceFile, or deleteFile. After success, discard every prior revision and anchor; never mutate the same file concurrently.",
    "Raw reads support parsing. Missing offset means 1, missing totalLines means lines, and missing hasMore/truncated means false.",
    'Batch operations are { kind: "read", file, options? } or { kind: "edit", file, changes }; do not mix reads and edits.',
    "",
    "CAPABILITIES",
    "",
    ...capabilityDocumentation().flatMap((line) => [line, ""]),
    `Paths are relative to Pi cwd unless absolute. Output is limited to ${formatSize(maxOutputBytes)}.`,
  ].join("\n");
}
