type PitJsonPrimitive = null | boolean | number | string;
type PitJsonValue =
  | PitJsonPrimitive
  | PitJsonValue[]
  | { [key: string]: PitJsonValue | undefined };
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
  readText(
    path: string,
    options?: { offset?: number; limit?: number },
  ): Promise<PitReadTextResult>;

  writeText(
    path: string,
    contents: string,
  ): Promise<{ path: string; bytes: number }>;

  editText(
    path: string,
    edits: Array<{ oldText: string; newText: string }>,
  ): Promise<{ path: string; edits: number }>;

  list(path?: string): Promise<PitWorkspaceEntry[]>;

  glob(
    patterns?: string | string[],
    options?: {
      dot?: boolean;
      onlyFiles?: boolean;
      ignore?: string[];
    },
  ): Promise<string[]>;

  stat(path: string): Promise<{
    size: number;
    modified: string;
    directory: boolean;
    file: boolean;
  }>;
}

interface PitShellCapability {
  exec(
    command: string,
    options?: { cwd?: string; timeoutMs?: number },
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
  notify(
    message: string,
    level?: "info" | "warning" | "error",
  ): Promise<null>;
}

interface PitFunctionsCapability {
  set(
    name: string,
    program: PitProgram,
  ): Promise<{ name: string; replaced: boolean }>;

  run(name: string, input?: PitJsonValue): Promise<PitResult>;
  has(name: string): Promise<boolean>;
  list(): Promise<string[]>;
  delete(name: string): Promise<boolean>;
}

interface PitContextCapability {
  get(): Promise<{
    cwd: string;
    mode: string;
    model: string | undefined;
    thinkingLevel: string;
    sessionFile: string | undefined;
  }>;
}

interface PitCapabilities {
  workspace: PitWorkspaceCapability;
  shell: PitShellCapability;
  http: PitHttpCapability;
  ui: PitUiCapability;
  context: PitContextCapability;
  functions: PitFunctionsCapability;
}

type PitProgram = (
  capabilities: PitCapabilities,
  input?: any,
) => PitResult | Promise<PitResult>;
