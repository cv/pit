import { formatSize } from "@earendil-works/pi-coding-agent";
import { capabilityDocumentation } from "./capability-registry.js";

export const PROMPT_SNIPPET =
  "Run sandboxed TypeScript with batched and parallel host capabilities plus reusable functions";

export const PROMPT_GUIDELINES = [
  "Use typescript for workspace inspection, file changes, shell commands, HTTP requests, UI interactions, and session-context queries.",
  "Call typescript with an anonymous async function for one-shot work, passing large or quote-heavy data through top-level params; use a named async function for recurring work or a call such as runTests() to invoke a saved function.",
  "Code passed to typescript is contextually type-checked; use diagnostics to correct capability names, arguments, missing awaits, and result types.",
  "In typescript, use Promise.all for fail-fast independent work; use Promise.allSettled or local catches when exploratory probes are optional; sequence dependencies and conflicting mutations.",
  "In typescript, use workspace.batch for transactional mutations or concurrent read-only inspection, and workspace.applyPatch for a transactional unified diff.",
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
    '    workspace.readText("package.json"),',
    '    shell.execFile("git", ["status", "--short"]),',
    "  ]);",
    "  return { packageJson: JSON.parse(file.text), status };",
    "}",
    "",
    "Capability calls are async. Use Promise.all for fail-fast independent work and Promise.allSettled or local catches for optional exploratory probes. Pass large or quote-heavy payloads through top-level params and accept them as the function second argument. Sequence dependencies and conflicting mutations, and return compact JSON-serializable data. Imports and direct filesystem, network, and subprocess access are unavailable.",
    "",
    "CAPABILITIES",
    "",
    ...capabilityDocumentation().flatMap((line) => [line, ""]),
    "REUSABLE AND COMPOSED FUNCTIONS",
    "",
    "Named top-level functions execute and save automatically on the active branch:",
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
