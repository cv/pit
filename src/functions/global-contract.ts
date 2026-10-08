import { globalFunctionGroups } from "./globals.js";

const GLOBAL_CONTRACT_PREAMBLE = `type PitJsonPrimitive = null | boolean | number | string;
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
type PitGhPrCreateOptions = PitGhCreateOptions & { base?: string; head?: string; draft?: boolean };
type PitGhPrMergeOptions = PitGhOptions & {
  method: "merge" | "squash" | "rebase";
  deleteBranch?: boolean;
  auto?: boolean;
};

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

type PitBatchReadOperation = {
  kind: "read";
  file: string;
  options?: { format?: PitReadFormat; offset?: number; limit?: number };
};

type PitBatchEditOperation = { kind: "edit"; file: string; changes: PitEditChangeSpec };

type PitBatchOperation = PitBatchReadOperation | PitBatchEditOperation;

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

type PitFunctionScope = "global" | "user" | "project" | "session";

type PitFunctionReference = {
  name: string;
  scope: PitFunctionScope;
  kind: "native" | "source" | "invalid";
  available: boolean;
};

type PitFunctionSummary = PitFunctionReference & {
  effective: boolean;
  effectiveScope: PitFunctionScope;
  readOnly: boolean;
  sealed: boolean;
  signature: string;
  summary: string;
  origin: string;
  lines: number;
  bytes: number;
  directDependencies: string[];
  directDependents: string[];
  overridesProject: boolean;
  overridesUser: boolean;
  overridesGlobal: boolean;
  error?: string;
};

type PitFunctionInspection = PitFunctionSummary & {
  overrideChain: Array<
    PitFunctionReference & { origin: string; effective: boolean; sealed: boolean }
  >;
  resolvedDependencies: Array<{ name: string; scope?: PitFunctionScope; available: boolean }>;
  next?: PitFunctionReference;
  directEffects: string[];
  effects: string[];
  documentation: string;
} & ({ kind: "source"; source: string } | { kind: "native" | "invalid"; source?: never });

type PitFunctionListOptions = {
  scope?: PitFunctionScope;
  allDefinitions?: boolean;
  offset?: number;
  limit?: number;
};

type PitFunctionListResult = {
  functions: PitFunctionSummary[];
  total: number;
  offset: number;
  nextOffset?: number;
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

type PitPromotionOptions = { to?: "user" | "project" };

type PitRemoveOptions = { cascade?: boolean };
type PitRemoveResult = { name: string; removed: string[] };

type PitContextRole =
  | "user"
  | "assistant"
  | "toolResult"
  | "note"
  | "notice"
  | "custom"
  | "bash"
  | "summary";
type PitContextState = "original" | "elided" | "summarized" | "replaced";
type PitContextOperation = "elide" | "summarize" | "note";
/** How the provider caches the prompt: what an edit's re-prefill estimate assumes. */
type PitContextCacheMode = "breakpoints" | "prefix" | "unknown";
/**
 * Whether the provider likely still holds the prompt cache: idle seconds since the last request or
 * cache_warm refresh, against the model's promptCache lifetime; unknown without one.
 */
type PitContextCacheState = {
  state: "warm" | "cold" | "unknown";
  idleSeconds: number | null;
  ttlSeconds: number | null;
  refreshedBy: "request" | "warming" | null;
};

type PitContextOutlineEntry = {
  id: string;
  role: PitContextRole;
  tool?: string;
  key?: string;
  tokens: number;
  reprefillTokens: number;
  state: PitContextState;
  editable: boolean;
  protectedReason?: string;
  pending?: PitContextOperation;
  preview: string;
};

type PitContextOutline = {
  leafId: string | null;
  contextTokens: number | null;
  contextWindow: number | null;
  estimatedTokens: number;
  cacheMode: PitContextCacheMode;
  cache: PitContextCacheState;
  entries: PitContextOutlineEntry[];
  nextAfter?: string;
  omitted: number;
};

type PitContextEntry = {
  id: string;
  role: PitContextRole;
  tool?: string;
  state: PitContextState | "omitted" | "compacted";
  original: { text: string; offset: number; totalChars: number; truncated: boolean };
  visible?: { text: string; totalChars: number; truncated: boolean };
  covers?: string[];
};

type PitContextEditReceipt = {
  status: "staged";
  appliesAt: "turn_end";
  operation: PitContextOperation;
  targets: string[];
  estimatedTokensFreed: number;
  estimatedReprefillTokens: number;
  cacheMode: PitContextCacheMode;
};

type PitContextSummaryInput = { from: string; to: string; summary: string };

type PitContextSummaryReceipt = PitContextEditReceipt & {
  summarizedEntries: number;
  summaryTokens: number;
};

type PitContextNoteReceipt = PitContextEditReceipt & {
  key: string;
  action: "created" | "replaced" | "removed";
};

type PitContextNotes = {
  notes: Array<{ key: string; entryId: string; tokens: number; pending?: boolean }>;
  tokens: number;
  budgetTokens: number;
  maxNotes: number;
};`;

function interfaceName(namespace: string): string {
  return namespace === "functions"
    ? "PitFunctionControls"
    : `Pit${namespace.charAt(0).toUpperCase()}${namespace.slice(1)}Functions`;
}

function indentDeclaration(declaration: string): string {
  return declaration
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

export function generateGlobalContract(): string {
  const groups = [...globalFunctionGroups()];
  const interfaces = groups
    .map(([name, definitions]) => {
      const methods = definitions
        .map((definition) => indentDeclaration(definition.declaration))
        .join("\n\n");
      return `interface ${interfaceName(name)} {\n${methods}\n}`;
    })
    .join("\n\n");
  const dependencies = groups.map(([name]) => `  ${name}: ${interfaceName(name)};`).join("\n");
  return `// Generated by scripts/generate-global-contract.ts. Do not edit.\n\n${GLOBAL_CONTRACT_PREAMBLE}\n\n${interfaces}\n\ninterface PitDependencies {\n${dependencies}\n}\n\ntype PitSavedInput<T extends (...args: any[]) => any> =\n  Parameters<T> extends [any, ...infer Rest] ? Rest[0] : undefined;\n\ntype PitProgram = (\n  dependencies: PitDependencies,\n  input?: any,\n) => PitResult | void | Promise<PitResult | void>;\n`;
}
