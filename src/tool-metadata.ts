import { formatSize } from "@earendil-works/pi-coding-agent";
import { capabilityDocumentation } from "./capability-registry.js";

export const PROMPT_SNIPPET =
  "Run sandboxed TypeScript with batched and parallel host capabilities plus reusable functions";

export const PROMPT_GUIDELINES = [
  "Use typescript for workspace inspection, file changes, shell commands, HTTP requests, UI interactions, and session-context queries.",
  "Code passed to typescript is contextually type-checked; use diagnostics to correct capability names, arguments, missing awaits, and result types.",
  "In typescript, prefer one tool invocation per step; batch independent capability calls with Promise.all inside it instead of issuing multiple parallel typescript calls, and sequence dependencies and conflicting mutations.",
  "Before editing in typescript, obtain the current revision and hashed anchors with workspace.read or workspace.search; re-read after a mismatch.",
  "Before an anonymous typescript call, compare the workflow with recent calls and saved functions; on the second substantially similar workflow, define or extend a parameterized named function instead of repeating inline code.",
  "In typescript, prefer matching signatures from the saved-function catalog in prior results; compose saved functions into workflows named after user intent.",
  "Return a compact JSON-serializable summary from typescript and use only capabilities for external effects.",
] as const;

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
    "Use an anonymous function only for genuinely one-shot work, destructuring just the needed capabilities. Prefer the reusable named-function contract below whenever work may recur or compose:",
    "",
    "async ({ workspace, shell }) => {",
    "  const [file, status] = await Promise.all([",
    '    workspace.read("package.json", { format: "raw" }),',
    '    shell.execFile("git", ["status", "--short"]),',
    "  ]);",
    "  return { packageJson: JSON.parse(file.content), status };",
    "}",
    "",
    "Capability calls are async. Put large data in top-level params, sequence dependencies and mutations, and use Promise.allSettled or local catches when optional probes should not fail the call. Imports and direct host access are unavailable.",
    "",
    "REUSABLE AND COMPOSED FUNCTIONS",
    "",
    "Before repeating inline code, define or extend a parameterized function named after user intent. Named functions execute immediately and save only after successful execution; saveOnly: true validates and saves without running:",
    "",
    "async function runTests({ shell }, input: { coverage?: boolean } = {}) {",
    '  const args = input.coverage ? ["run", "coverage"] : ["test"];',
    '  return shell.execFile("npm", args, { raise: true });',
    "}",
    "",
    "Successful results include active saved-function signatures. Later invoke runTests() or runTests({ coverage: true }); only referenced definitions and dependencies are injected.",
    "To define now and invoke later, submit the named function with saveOnly: true and omit top-level params.",
    "",
    "Compose recurring sequences into higher-level named workflows. For example, publishChanges can await runValidation(), then use shell.execFile for git add, commit, and push with { raise: true }.",
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
    "Change kinds: replace, delete, insertBefore, insertAfter, replaceFile, deleteFile. An optional end anchor extends replace/delete. Create a missing file with revision: null and one replaceFile change. On revision or anchor mismatch, re-read before retrying. Raw mode is for JSON or other machine parsing. Missing offset means 1, missing totalLines means lines, and missing hasMore/truncated means false.",
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
