import { commandsCapability } from "./commands.js";
import { contextCapability } from "./context.js";
import {
  type CapabilityDefinition,
  type CapabilityMethodDefinition,
  defineCapabilities,
} from "./core.js";
import { functionsCapability } from "./functions.js";
import { ghCapability } from "./gh.js";
import { gitCapability } from "./git.js";
import { httpCapability } from "./http.js";
import { modelsCapability } from "./models.js";
import { npmCapability } from "./npm.js";
import { runtimeCapability } from "./runtime.js";
import { sessionCapability } from "./session.js";
import { shellCapability } from "./shell.js";
import { uiCapability } from "./ui.js";
import { workspaceCapability } from "./workspace.js";

export type { CapabilityMethodDefinition } from "./core.js";

export const CAPABILITY_CONTRACT_PREAMBLE = `type PitJsonPrimitive = null | boolean | number | string;
type PitJsonValue = PitJsonPrimitive | PitJsonValue[] | { [key: string]: PitJsonValue | undefined };
type PitResult = PitJsonValue | undefined;

type PitProcessOptions = {
  cwd?: string;
  timeoutMs?: number;
  raise?: boolean;
  maxBytes?: number;
  maxLines?: number;
  truncate?: "head" | "tail";
};

type PitProcessResult = {
  stdout: string;
  stderr: string;
  code: number;
  truncated: boolean;
};

type PitNpmTestOptions = PitProcessOptions & {
  args?: string[];
  coverage?: boolean;
};

type PitNpmInstallOptions = PitProcessOptions & {
  dev?: boolean;
  exact?: boolean;
  packageLockOnly?: boolean;
  ignoreScripts?: boolean;
};

type PitNpmAuditOptions = PitProcessOptions & {
  omitDev?: boolean;
};

type PitNpmPackOptions = PitProcessOptions & {
  dryRun?: boolean;
};

type PitGhOptions = PitProcessOptions & { repo?: string; args?: string[] };
type PitGhJsonOptions = PitGhOptions & { json?: string[] };
type PitGhListOptions = PitGhJsonOptions & {
  state?: "open" | "closed" | "all";
  limit?: number;
  author?: string;
  assignee?: string;
  labels?: string[];
  search?: string;
};
type PitGhPrListOptions = Omit<PitGhListOptions, "state"> & {
  state?: "open" | "closed" | "merged" | "all";
  base?: string;
  head?: string;
  draft?: boolean;
};
type PitGhRunListOptions = PitGhJsonOptions & {
  limit?: number;
  branch?: string;
  commit?: string;
  event?: string;
  status?: string;
  user?: string;
  workflow?: string;
};
type PitGhCreateOptions = PitGhOptions & { title: string; body?: string };

type PitReadFormat = "hashed" | "raw";
type PitLineAnchor = \`\${number}:\${string}\`;

type PitEditChange =
  | { kind: "replace"; start: PitLineAnchor; end?: PitLineAnchor; content: string }
  | { kind: "delete"; start: PitLineAnchor; end?: PitLineAnchor }
  | { kind: "insertBefore" | "insertAfter"; anchor: PitLineAnchor; content: string }
  | { kind: "replaceFile"; content: string }
  | { kind: "deleteFile" };

type PitEditChangeSpec = {
  revision: string | null;
  changes: [PitEditChange, ...PitEditChange[]];
};

type PitReadResult = {
  file: string;
  format: PitReadFormat;
  content: string;
  revision: string;
  offset?: number;
  lines: number;
  totalLines?: number;
  hasMore?: true;
  truncated?: true;
};

type PitEditResult = {
  file: string;
  revision: string | null;
  applied: number;
  bytes: number;
  deleted: boolean;
};

type PitWorkspaceEntry = {
  name: string;
  type: "file" | "directory" | "symlink";
};

type PitBatchOperation =
  | {
      kind: "read";
      file: string;
      options?: { format?: PitReadFormat; offset?: number; limit?: number };
    }
  | { kind: "edit"; file: string; changes: PitEditChangeSpec };

type PitSlashCommand = {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
  sourceInfo: {
    path: string;
    source: string;
    scope: "user" | "project" | "temporary";
    origin: "package" | "top-level";
    baseDir?: string;
  };
};

type PitModelMetadata = {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  input: string[];
  contextWindow: number;
  maxTokens: number;
  available: boolean;
  scoped: boolean;
};

type PitPersistentFunctionMetadata = {
  name: string;
  signature: string;
  summary: string;
  parameters: Array<{ name: string; description?: string }>;
};

type PitFunctionScope = "global" | "project" | "session";

type PitSavedFunctionMetadata = {
  name: string;
  scope: PitFunctionScope;
  signature: string;
  lines: number;
  bytes: number;
  directDependencies: string[];
  directDependents: string[];
  overridesProject: boolean;
  overridesGlobal: boolean;
};

type PitSavedFunctionRemovalPlan = {
  name: string;
  scope: PitFunctionScope;
  directDependents: string[];
  transitiveDependents: string[];
  removalClosure: string[];
  requiresCascade: boolean;
  blocked: boolean;
};

type PitPromotionOptions = { to?: "global" | "project" };

type PitRemoveOptions = { cascade?: boolean };
type PitRemoveResult = { name: string; removed: string[] };`;

export const CAPABILITY_REGISTRY = defineCapabilities({
  workspace: workspaceCapability,
  git: gitCapability,
  npm: npmCapability,
  gh: ghCapability,
  shell: shellCapability,
  http: httpCapability,
  ui: uiCapability,
  context: contextCapability,
  session: sessionCapability,
  commands: commandsCapability,
  models: modelsCapability,
  runtime: runtimeCapability,
  functions: functionsCapability,
});

export type CapabilityName = keyof typeof CAPABILITY_REGISTRY;

function methodNames<const Registry extends Record<string, CapabilityDefinition>>(
  registry: Registry,
) {
  return Object.fromEntries(
    Object.entries(registry).map(([name, definition]) => [name, Object.keys(definition.methods)]),
  ) as { [Name in keyof Registry]: Array<keyof Registry[Name]["methods"] & string> };
}

export const CAPABILITY_METHODS = methodNames(CAPABILITY_REGISTRY);

export function getCapabilityMethodDefinition(
  capability: string,
  method: string,
): CapabilityMethodDefinition | undefined {
  const definition = CAPABILITY_REGISTRY[capability as CapabilityName];
  return definition?.methods[method as keyof typeof definition.methods] as
    | CapabilityMethodDefinition
    | undefined;
}

export function validateCapabilityCall(capability: string, method: string, args: unknown[]): void {
  const methodDefinition = getCapabilityMethodDefinition(capability, method);
  if (!methodDefinition) {
    throw new Error(`Unknown capability or method: ${capability}.${method}`);
  }
  if (
    args.length < methodDefinition.minimumArguments ||
    args.length > methodDefinition.maximumArguments
  ) {
    const range =
      methodDefinition.minimumArguments === methodDefinition.maximumArguments
        ? String(methodDefinition.minimumArguments)
        : `${methodDefinition.minimumArguments}-${methodDefinition.maximumArguments}`;
    throw new Error(
      `${capability}.${method} expects ${range} argument(s); received ${args.length}`,
    );
  }
}

export function capabilityDocumentation(): string[] {
  return Object.entries(CAPABILITY_REGISTRY).map(([name, definition]) => {
    const promptSummary = "promptSummary" in definition ? definition.promptSummary : undefined;
    const documentation =
      promptSummary ??
      ("documentation" in definition
        ? definition.documentation
        : Object.values(definition.methods)
            .map((method) => method.documentation)
            .join("; "));
    return `${name}: ${documentation}.`;
  });
}

function indentDeclaration(declaration: string): string {
  return declaration
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

export function generateCapabilityContract(): string {
  const interfaces = Object.values(CAPABILITY_REGISTRY)
    .map((definition) => {
      const methods = Object.values(definition.methods)
        .map((method) => indentDeclaration(method.declaration))
        .join("\n\n");
      return `interface ${definition.interfaceName} {\n${methods}\n}`;
    })
    .join("\n\n");
  const capabilities = Object.entries(CAPABILITY_REGISTRY)
    .map(([name, definition]) => `  ${name}: ${definition.interfaceName};`)
    .join("\n");
  return `// Generated by scripts/generate-capability-contract.ts. Do not edit.\n\n${CAPABILITY_CONTRACT_PREAMBLE}\n\n${interfaces}\n\ninterface PitCapabilities {\n${capabilities}\n}\n\ntype PitSavedInput<T extends (...args: any[]) => any> =\n  Parameters<T> extends [any, ...infer Rest] ? Rest[0] : undefined;\n\ntype PitProgram = (\n  capabilities: PitCapabilities,\n  input?: any,\n) => PitResult | void | Promise<PitResult | void>;\n`;
}
