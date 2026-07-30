export interface CapabilityMethodDefinition {
  declaration: string;
  documentation: string;
  minimumArguments: number;
  maximumArguments: number;
}

interface CapabilityDefinition {
  interfaceName: string;
  methods: Record<string, CapabilityMethodDefinition>;
}

export const CAPABILITY_CONTRACT_PREAMBLE = `type PitJsonPrimitive = null | boolean | number | string;
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
};`;

export const CAPABILITY_REGISTRY = {
  workspace: {
    interfaceName: "PitWorkspaceCapability",
    methods: {
      readText: {
        declaration:
          "readText(path: string, options?: { offset?: number; limit?: number }): Promise<PitReadTextResult>;",
        documentation:
          "workspace.readText(path, options?) -> { text, truncated, offset, lines, totalLines } (not a raw string)",
        minimumArguments: 1,
        maximumArguments: 2,
      },
      writeText: {
        declaration:
          "writeText(path: string, contents: string): Promise<{ path: string; bytes: number }>;",
        documentation: "workspace.writeText(path, contents)",
        minimumArguments: 2,
        maximumArguments: 2,
      },
      editText: {
        declaration: `editText(
  path: string,
  edits: Array<{ oldText: string; newText: string }>,
): Promise<{ path: string; edits: number }>;`,
        documentation: "workspace.editText(path, edits)",
        minimumArguments: 2,
        maximumArguments: 2,
      },
      applyPatch: {
        declaration: `applyPatch(patch: string): Promise<{
  files: Array<{
    path: string;
    kind: "create" | "modify" | "delete";
    hunks: number;
    bytes: number;
  }>;
}>;`,
        documentation: "workspace.applyPatch(patch)",
        minimumArguments: 1,
        maximumArguments: 1,
      },
      batch: {
        declaration: `batch(
  operations: Array<
    | { kind: "write"; path: string; contents: string }
    | { kind: "edit"; path: string; edits: Array<{ oldText: string; newText: string }> }
  >,
): Promise<{
  files: Array<{ path: string; kind: "write" | "edit"; bytes: number; edits?: number }>;
}>;`,
        documentation: "workspace.batch(operations)",
        minimumArguments: 1,
        maximumArguments: 1,
      },
      list: {
        declaration: "list(path?: string): Promise<PitWorkspaceEntry[]>;",
        documentation: "workspace.list(path?)",
        minimumArguments: 0,
        maximumArguments: 1,
      },
      glob: {
        declaration: `glob(
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
}>;`,
        documentation:
          "workspace.glob(patterns?, { limit?, dot?, onlyFiles?, ignore? }) -> { entries, truncated }",
        minimumArguments: 0,
        maximumArguments: 2,
      },
      search: {
        declaration: `search(
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
}>;`,
        documentation: "workspace.search(query, options?)",
        minimumArguments: 1,
        maximumArguments: 2,
      },
      stat: {
        declaration: `stat(path: string): Promise<{
  size: number;
  modified: string;
  directory: boolean;
  file: boolean;
}>;`,
        documentation: "workspace.stat(path)",
        minimumArguments: 1,
        maximumArguments: 1,
      },
    },
  },
  shell: {
    interfaceName: "PitShellCapability",
    methods: {
      execFile: {
        declaration: `execFile(
  program: string,
  args: string[],
  options?: { cwd?: string; timeoutMs?: number; raise?: boolean },
): Promise<{
  stdout: string;
  stderr: string;
  code: number;
  truncated: boolean;
}>;`,
        documentation: "shell.execFile(program, args, options?) for argument-safe direct execution",
        minimumArguments: 2,
        maximumArguments: 3,
      },
      exec: {
        declaration: `exec(
  command: string,
  options?: { cwd?: string; timeoutMs?: number; raise?: boolean },
): Promise<{
  stdout: string;
  stderr: string;
  code: number;
  truncated: boolean;
}>;`,
        documentation:
          "shell.exec(command, options?) for shell syntax; shell methods return { stdout, stderr, code, truncated }; Nonzero exits are data by default and { raise: true } throws",
        minimumArguments: 1,
        maximumArguments: 2,
      },
    },
  },
  http: {
    interfaceName: "PitHttpCapability",
    methods: {
      request: {
        declaration: `request(
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
}>;`,
        documentation: "http.request(url, options?) -> { status, ok, headers, body, truncated }",
        minimumArguments: 1,
        maximumArguments: 2,
      },
    },
  },
  ui: {
    interfaceName: "PitUiCapability",
    methods: {
      confirm: {
        declaration: "confirm(title: string, message: string): Promise<boolean>;",
        documentation: "ui.confirm(title, message)",
        minimumArguments: 2,
        maximumArguments: 2,
      },
      input: {
        declaration: "input(title: string, placeholder?: string): Promise<string | undefined>;",
        documentation: "ui.input(title, placeholder?)",
        minimumArguments: 1,
        maximumArguments: 2,
      },
      select: {
        declaration: "select(title: string, options: string[]): Promise<string | undefined>;",
        documentation: "ui.select(title, options)",
        minimumArguments: 2,
        maximumArguments: 2,
      },
      notify: {
        declaration:
          'notify(message: string, level?: "info" | "warning" | "error"): Promise<null>;',
        documentation: "ui.notify(message, level?) (UI availability depends on mode)",
        minimumArguments: 1,
        maximumArguments: 2,
      },
    },
  },
  context: {
    interfaceName: "PitContextCapability",
    methods: {
      get: {
        declaration: `get(): Promise<{
  cwd: string;
  mode: string;
  model: string | undefined;
  thinkingLevel: string;
  sessionFile: string | undefined;
  savedFunctions: string[];
}>;`,
        documentation:
          "context.get() -> cwd, mode, model, thinkingLevel, sessionFile, savedFunctions",
        minimumArguments: 0,
        maximumArguments: 0,
      },
    },
  },
} as const satisfies Record<string, CapabilityDefinition>;

export type CapabilityName = keyof typeof CAPABILITY_REGISTRY;

function methodNames<const Registry extends Record<string, CapabilityDefinition>>(
  registry: Registry,
) {
  return Object.fromEntries(
    Object.entries(registry).map(([name, definition]) => [name, Object.keys(definition.methods)]),
  ) as { [Name in keyof Registry]: Array<keyof Registry[Name]["methods"] & string> };
}

export const CAPABILITY_METHODS = methodNames(CAPABILITY_REGISTRY);

export function validateCapabilityCall(capability: string, method: string, args: unknown[]): void {
  const definition = CAPABILITY_REGISTRY[capability as CapabilityName];
  const methodDefinition = definition?.methods[method as keyof typeof definition.methods] as
    | CapabilityMethodDefinition
    | undefined;
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
    const methods = Object.values(definition.methods)
      .map((method) => method.documentation)
      .join("; ");
    return `${name}: ${methods}.`;
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
  return `${CAPABILITY_CONTRACT_PREAMBLE}\n\n${interfaces}\n\ninterface PitCapabilities {\n${capabilities}\n}\n\ntype PitSavedInput<T extends (...args: any[]) => any> =\n  Parameters<T> extends [any, ...infer Rest] ? Rest[0] : undefined;\n\ntype PitProgram = (\n  capabilities: PitCapabilities,\n  input?: any,\n) => PitResult | void | Promise<PitResult | void>;\n`;
}
