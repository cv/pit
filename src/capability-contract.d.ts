type PitJsonPrimitive = null | boolean | number | string;
type PitJsonValue = PitJsonPrimitive | PitJsonValue[] | { [key: string]: PitJsonValue | undefined };
type PitResult = PitJsonValue | undefined;

type PitReadTextResult = {
  text: string;
  truncated: boolean;
  offset: number;
  lines: number;
  totalLines: number;
};

type PitWorkspaceEntry = {
  name: string;
  type: "file" | "directory" | "symlink";
};

interface PitWorkspaceCapability {
  readText(path: string, options?: { offset?: number; limit?: number }): Promise<PitReadTextResult>;

  writeText(path: string, contents: string): Promise<{ path: string; bytes: number }>;

  editText(
    path: string,
    edits: Array<{ oldText: string; newText: string }>,
  ): Promise<{ path: string; edits: number }>;

  applyPatch(patch: string): Promise<{
    files: Array<{
      path: string;
      kind: "create" | "modify" | "delete";
      hunks: number;
      bytes: number;
    }>;
  }>;

  batch(
    operations: Array<
      | { kind: "write"; path: string; contents: string }
      | { kind: "edit"; path: string; edits: Array<{ oldText: string; newText: string }> }
    >,
  ): Promise<{
    files: Array<{ path: string; kind: "write" | "edit"; bytes: number; edits?: number }>;
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
      path: string;
      line: number;
      column: number;
      text: string;
      before: string[];
      after: string[];
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
    options?: { cwd?: string; timeoutMs?: number; raise?: boolean },
  ): Promise<{
    stdout: string;
    stderr: string;
    code: number;
    truncated: boolean;
  }>;

  exec(
    command: string,
    options?: { cwd?: string; timeoutMs?: number; raise?: boolean },
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
