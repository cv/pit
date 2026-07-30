import { formatSize } from "@earendil-works/pi-coding-agent";
import { capabilityDocumentation } from "./capability-registry.js";

export const PROMPT_SNIPPET =
  "Run sandboxed TypeScript with batched and parallel host capabilities plus reusable functions";

export const PROMPT_GUIDELINES = [
  "Use typescript for workspace inspection, file changes, shell commands, HTTP requests, UI interactions, and session-context queries.",
  "Call typescript with an anonymous async function for one-shot work, passing large or quote-heavy data through top-level params; use a named async function for recurring work or a call such as runTests() to invoke a saved function.",
  "Code passed to typescript is contextually type-checked; use diagnostics to correct capability names, arguments, missing awaits, and result types.",
  "In typescript, use Promise.all for fail-fast independent work; use Promise.allSettled or local catches when exploratory probes are optional; sequence dependencies and conflicting mutations.",
  "In typescript, use workspace.read's default hashed mode in a prior call or workspace.search to obtain a revision and anchors before editing; on mismatch, re-read instead of retrying stale anchors, and use raw mode only for machine parsing.",
  "In typescript, use named functions for recurring workflows and compose saved functions into higher-level functions named after user intent.",
  "In typescript, annotate saved-function input parameters so initial params and later calls retain type checking.",
  "In typescript, prefer shell.execFile(program, args) for ordinary commands; use shell.exec only for shell syntax such as pipes or redirection.",
  "In typescript, use { raise: true } when a failed shell command should stop a composed workflow.",
  "Return a compact JSON-serializable summary from typescript and use only capabilities for external effects.",
] as const;

export const CODE_DESCRIPTION =
  'A contextually type-checked TypeScript expression. Use an anonymous function for one-shot work, a named top-level function such as async function runTests({ shell }) { return shell.execFile("npm", ["test"], { raise: true }); } for recurring work, or runTests() to invoke a saved function. Start independent calls with Promise.all, await capability promises, do not import modules, and return compact JSON-serializable data.';

export const PARAMS_DESCRIPTION =
  "Optional JSON-serializable input passed as the function second argument. Prefer params over embedding large patches, file contents, commit messages, or quote-heavy data in code. Annotate the input parameter for contextual validation.";

export function createToolDescription(maxOutputBytes: number): string {
  return [
    "Execute a contextually type-checked TypeScript expression in a fresh restricted process.",
    "",
    "CALLING CONTRACT",
    "",
    "One-shot work uses an anonymous function and destructures only needed capabilities:",
    "",
    "async ({ workspace, shell }) => {",
    "  const [file, status] = await Promise.all([",
    '    workspace.read("package.json", { format: "raw" }),',
    '    shell.execFile("git", ["status", "--short"]),',
    "  ]);",
    "  return { packageJson: JSON.parse(file.content), status };",
    "}",
    "",
    "Capability calls are async. Use Promise.all for fail-fast independent work and Promise.allSettled or local catches for optional exploratory probes. Pass large or quote-heavy payloads through top-level params and accept them as the function second argument. Sequence dependencies and conflicting mutations, and return compact JSON-serializable data. Imports and direct filesystem, network, and subprocess access are unavailable.",
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
    'Batch operations are { kind: "read", file, options? } or { kind: "edit", file, changes }. A batch must contain only reads or only edits.',
    "",
    "CAPABILITIES",
    "",
    ...capabilityDocumentation().flatMap((line) => [line, ""]),
    "REUSABLE AND COMPOSED FUNCTIONS",
    "",
    "Named top-level functions execute immediately and are saved on the active branch only after successful execution:",
    "",
    "async function runTests({ shell }, input: { coverage?: boolean } = {}) {",
    '  const args = input.coverage ? ["run", "coverage"] : ["test"];',
    '  return shell.execFile("npm", args, { raise: true });',
    "}",
    "",
    "Provide top-level params for initial input. Later invoke runTests() or runTests({ coverage: true }). Only referenced saved functions and transitive dependencies are injected. Use context.get().savedFunctions or /functions to inspect names.",
    "",
    "Compose recurring sequences into higher-level named workflows. For example, publishChanges can await runValidation(), then use shell.execFile for git add, commit, and push with { raise: true }.",
    "",
    "Paths are relative to Pi cwd unless absolute. Output is limited to " +
      formatSize(maxOutputBytes) +
      ".",
  ].join("\n");
}
