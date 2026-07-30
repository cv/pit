type PitJsonPrimitive = null | boolean | number | string;
type PitJsonValue = PitJsonPrimitive | PitJsonValue[] | { [key: string]: PitJsonValue | undefined };
type PitResult = PitJsonValue | undefined;

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

interface PitShellCapability {
  execFile(
    program: string,
    args: string[],
    options?: {
      cwd?: string;
      timeoutMs?: number;
      raise?: boolean;
      maxBytes?: number;
      maxLines?: number;
      truncate?: "head" | "tail";
    },
  ): Promise<{
    stdout: string;
    stderr: string;
    code: number;
    truncated: boolean;
  }>;

  exec(
    command: string,
    options?: {
      cwd?: string;
      timeoutMs?: number;
      raise?: boolean;
      maxBytes?: number;
      maxLines?: number;
      truncate?: "head" | "tail";
    },
  ): Promise<{
    stdout: string;
    stderr: string;
    code: number;
    truncated: boolean;
  }>;
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
  }>;
}

interface PitCapabilities {
  workspace: PitWorkspaceCapability;
  shell: PitShellCapability;
  http: PitHttpCapability;
  ui: PitUiCapability;
  context: PitContextCapability;
}

type PitSavedInput<T extends (...args: any[]) => any> =
  Parameters<T> extends [any, ...infer Rest] ? Rest[0] : undefined;

type PitProgram = (
  capabilities: PitCapabilities,
  input?: any,
) => PitResult | void | Promise<PitResult | void>;
