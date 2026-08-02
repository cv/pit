type PitJsonPrimitive = null | boolean | number | string;
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

type PitGhOptions = PitProcessOptions & { repo?: string };
type PitGhListOptions = PitGhOptions & { state?: "open" | "closed" | "all"; limit?: number };
type PitGhCreateOptions = PitGhOptions & { title: string; body?: string };

type PitReadFormat = "hashed" | "raw";
type PitLineAnchor = `${number}:${string}`;

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

type PitProjectFunctionMetadata = {
  name: string;
  signature: string;
  summary: string;
  parameters: Array<{ name: string; description?: string }>;
};

type PitSavedFunctionMetadata = {
  name: string;
  scope: "project" | "session";
  signature: string;
  lines: number;
  bytes: number;
};

interface PitWorkspaceCapability {
  read(
    file: string,
    options?: { format?: PitReadFormat; offset?: number; limit?: number },
  ): Promise<PitReadResult>;

  edit(file: string, changes: PitEditChangeSpec): Promise<PitEditResult>;

  batch(
    operations: PitBatchOperation[],
    options?: { failure?: "fail-fast" | "settled" },
  ): Promise<{
    results: Array<
      | { kind: "read"; index: number; ok: true; value: PitReadResult }
      | { kind: "read"; index: number; ok: false; value?: undefined; error: string }
      | { kind: "edit"; index: number; ok: true; value: PitEditResult }
    >;
  }>;

  list(path?: string): Promise<PitWorkspaceEntry[]>;

  glob(
    patterns?: string | string[],
    options?: {
      dot?: boolean;
      onlyFiles?: boolean;
      ignore?: string[];
      limit?: number;
    },
  ): Promise<{
    entries: string[];
    truncated: boolean;
  }>;

  search(
    query: string,
    options?: {
      path?: string;
      glob?: string | string[];
      regex?: boolean;
      caseSensitive?: boolean;
      contextLines?: number;
      limit?: number;
      ignore?: string[];
      dot?: boolean;
    },
  ): Promise<{
    matches: Array<{
      file: string;
      revision: string;
      line: number;
      anchor: PitLineAnchor;
      column: number;
      text: string;
      before: Array<{ line: number; anchor: PitLineAnchor; text: string }>;
      after: Array<{ line: number; anchor: PitLineAnchor; text: string }>;
    }>;
    truncated: boolean;
    filesSearched: number;
    filesSkipped: number;
  }>;

  stat(path: string): Promise<{
    size: number;
    modified: string;
    directory: boolean;
    file: boolean;
  }>;
}

interface PitGitCapability {
  status(args?: string[], options?: PitProcessOptions): Promise<PitProcessResult>;

  diff(args?: string[], options?: PitProcessOptions): Promise<PitProcessResult>;

  log(args?: string[], options?: PitProcessOptions): Promise<PitProcessResult>;

  add(args?: string[], options?: PitProcessOptions): Promise<PitProcessResult>;

  commit(args?: string[], options?: PitProcessOptions): Promise<PitProcessResult>;

  show(args?: string[], options?: PitProcessOptions): Promise<PitProcessResult>;

  push(args?: string[], options?: PitProcessOptions): Promise<PitProcessResult>;

  tag(args?: string[], options?: PitProcessOptions): Promise<PitProcessResult>;
}

interface PitNpmCapability {
  run(script: string, args?: string[], options?: PitProcessOptions): Promise<PitProcessResult>;

  test(options?: PitNpmTestOptions): Promise<PitProcessResult>;

  install(packages?: string[], options?: PitNpmInstallOptions): Promise<PitProcessResult>;

  audit(options?: PitNpmAuditOptions): Promise<PitProcessResult>;

  outdated(options?: PitProcessOptions): Promise<PitProcessResult>;

  pack(options?: PitNpmPackOptions): Promise<PitProcessResult>;
}

interface PitGhCapability {
  issueList(options?: PitGhListOptions): Promise<PitProcessResult>;

  issueView(number: number, options?: PitGhOptions): Promise<PitProcessResult>;

  issueCreate(input: PitGhCreateOptions): Promise<PitProcessResult>;

  issueComment(number: number, body: string, options?: PitGhOptions): Promise<PitProcessResult>;

  issueClose(number: number, options?: PitGhOptions): Promise<PitProcessResult>;

  prList(options?: PitGhListOptions): Promise<PitProcessResult>;

  prView(number: number, options?: PitGhOptions): Promise<PitProcessResult>;

  runList(options?: PitGhOptions & { limit?: number }): Promise<PitProcessResult>;

  runView(id: number, options?: PitGhOptions): Promise<PitProcessResult>;

  releaseView(tag?: string, options?: PitGhOptions): Promise<PitProcessResult>;

  releaseCreate(tag: string, input: PitGhCreateOptions): Promise<PitProcessResult>;

  api(endpoint: string, args?: string[], options?: PitProcessOptions): Promise<PitProcessResult>;
}

interface PitShellCapability {
  execFile(program: string, args: string[], options?: PitProcessOptions): Promise<PitProcessResult>;

  exec(command: string, options?: PitProcessOptions): Promise<PitProcessResult>;
}

interface PitHttpCapability {
  request(
    url: string,
    options?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      maxBytes?: number;
    },
  ): Promise<{
    status: number;
    ok: boolean;
    headers: Record<string, string>;
    body: string;
    truncated: boolean;
  }>;
}

interface PitUiCapability {
  confirm(title: string, message: string): Promise<boolean>;

  input(title: string, placeholder?: string): Promise<string | undefined>;

  select(title: string, options: string[]): Promise<string | undefined>;

  notify(message: string, level?: "info" | "warning" | "error"): Promise<null>;
}

interface PitContextCapability {
  get(): Promise<{
    cwd: string;
    mode: string;
    model: string | undefined;
    thinkingLevel: string;
    sessionFile: string | undefined;
    savedFunctions: string[];
    projectFunctions: string[];
    sessionFunctions: string[];
    projectFunctionsEnabled: boolean;
  }>;
}

interface PitSessionCapability {
  info(): Promise<{
    id: string;
    file: string | undefined;
    name: string | undefined;
    leafId: string | null;
    entryCount: number;
    branchEntryCount: number;
    contextTokens: number | null | undefined;
    contextWindow: number | undefined;
    contextPercent: number | null | undefined;
  }>;

  getName(): Promise<string | undefined>;

  setName(name: string): Promise<{ name: string }>;

  compact(instructions?: string): Promise<{
    firstKeptEntryId: string;
    tokensBefore: number;
    estimatedTokensAfter: number | undefined;
  }>;
}

interface PitCommandsCapability {
  list(): Promise<{ commands: PitSlashCommand[]; truncated: boolean }>;
}

interface PitModelsCapability {
  current(): Promise<PitModelMetadata | undefined>;

  list(options?: {
    availableOnly?: boolean;
    query?: string;
    limit?: number;
  }): Promise<{ models: PitModelMetadata[]; truncated: boolean }>;

  set(provider: string, id: string): Promise<{ provider: string; id: string; changed: boolean }>;
}

interface PitFunctionsCapability {
  list(): Promise<PitProjectFunctionMetadata[]>;

  get(name: string): Promise<PitProjectFunctionMetadata & { source: string }>;

  remove(name: string): Promise<{ name: string; removed: boolean }>;

  listAll(): Promise<PitSavedFunctionMetadata[]>;

  getSaved(name: string): Promise<PitSavedFunctionMetadata & { source: string }>;

  promote(name: string, summary: string): Promise<{ name: string; promoted: true }>;

  removeSession(name: string): Promise<{ name: string; removed: string[] }>;
}

interface PitCapabilities {
  workspace: PitWorkspaceCapability;
  git: PitGitCapability;
  npm: PitNpmCapability;
  gh: PitGhCapability;
  shell: PitShellCapability;
  http: PitHttpCapability;
  ui: PitUiCapability;
  context: PitContextCapability;
  session: PitSessionCapability;
  commands: PitCommandsCapability;
  models: PitModelsCapability;
  functions: PitFunctionsCapability;
}

type PitSavedInput<T extends (...args: any[]) => any> =
  Parameters<T> extends [any, ...infer Rest] ? Rest[0] : undefined;

type PitProgram = (
  capabilities: PitCapabilities,
  input?: any,
) => PitResult | void | Promise<PitResult | void>;
