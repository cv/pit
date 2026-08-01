import type { ResultRendererKey } from "./result-renderer-types.js";

export interface CapabilityMethodDefinition {
  declaration: string;
  documentation: string;
  callDescription: string;
  resultRenderer?: ResultRendererKey;
  minimumArguments: number;
  maximumArguments: number;
}

interface CapabilityDefinition {
  interfaceName: string;
  documentation?: string;
  methods: Record<string, CapabilityMethodDefinition>;
}

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

type PitProjectFunctionMetadata = {
  name: string;
  signature: string;
  summary: string;
  parameters: Array<{ name: string; description?: string }>;
};`;

function gitMethodDefinition(method: string, callDescription: string): CapabilityMethodDefinition {
  return {
    declaration: `${method}(args?: string[], options?: PitProcessOptions): Promise<PitProcessResult>;`,
    documentation: `git.${method}(args?, options?)`,
    callDescription,
    resultRenderer: `git.${method}` as ResultRendererKey,
    minimumArguments: 0,
    maximumArguments: 2,
  };
}

export const CAPABILITY_REGISTRY = {
  workspace: {
    interfaceName: "PitWorkspaceCapability",
    methods: {
      read: {
        callDescription: "Read workspace files",
        resultRenderer: "read",
        declaration: `read(
  file: string,
  options?: { format?: PitReadFormat; offset?: number; limit?: number },
): Promise<PitReadResult>;`,
        documentation:
          'workspace.read(file, { format?: "hashed" | "raw", offset?, limit? }) defaults to hashed line:hash anchors and sparse metadata',
        minimumArguments: 1,
        maximumArguments: 2,
      },
      edit: {
        callDescription: "Edit workspace files",
        resultRenderer: "edit",
        declaration: "edit(file: string, changes: PitEditChangeSpec): Promise<PitEditResult>;",
        documentation:
          'workspace.edit(file, { revision, changes }); replace/delete use "start"/optional "end", insertBefore/insertAfter use "anchor", and replaceFile/deleteFile need no anchor',
        minimumArguments: 2,
        maximumArguments: 2,
      },
      batch: {
        callDescription: "Run workspace batch",
        resultRenderer: "batch",
        declaration: `batch(
  operations: PitBatchOperation[],
  options?: { failure?: "fail-fast" | "settled" },
): Promise<{
  results: Array<
    | { kind: "read"; index: number; ok: true; value: PitReadResult }
    | { kind: "read"; index: number; ok: false; value?: undefined; error: string }
    | { kind: "edit"; index: number; ok: true; value: PitEditResult }
  >;
}>;`,
        documentation:
          'workspace.batch uses homogeneous reads [{ kind: "read", file, options? }] or edits [{ kind: "edit", file, changes: { revision, changes } }], accepts { failure?: "fail-fast" | "settled" }, and returns ordered { results }',
        minimumArguments: 1,
        maximumArguments: 2,
      },
      list: {
        callDescription: "List workspace entries",
        resultRenderer: "list",
        declaration: "list(path?: string): Promise<PitWorkspaceEntry[]>;",
        documentation: "workspace.list(path?)",
        minimumArguments: 0,
        maximumArguments: 1,
      },
      glob: {
        callDescription: "List matching files",
        resultRenderer: "glob",
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
        callDescription: "Search workspace",
        resultRenderer: "search",
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
}>;`,
        documentation:
          "workspace.search(query, { path?, glob?, regex?, caseSensitive?, contextLines?: 0..10, limit?: 1..500, ignore?, dot? }) returns edit-ready anchors and revisions",
        minimumArguments: 1,
        maximumArguments: 2,
      },
      stat: {
        callDescription: "Inspect file metadata",
        resultRenderer: "stat",
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
  git: {
    interfaceName: "PitGitCapability",
    documentation:
      "git.status, git.diff, git.log, git.add, git.commit, git.show, git.push, and git.tag accept optional argument arrays and shell.execFile options; results are bounded",
    methods: {
      status: gitMethodDefinition("status", "Inspect Git status"),
      diff: gitMethodDefinition("diff", "Inspect Git changes"),
      log: gitMethodDefinition("log", "Inspect Git history"),
      add: gitMethodDefinition("add", "Stage Git changes"),
      commit: gitMethodDefinition("commit", "Commit Git changes"),
      show: gitMethodDefinition("show", "Inspect a Git object"),
      push: gitMethodDefinition("push", "Push Git changes"),
      tag: gitMethodDefinition("tag", "Manage Git tags"),
    },
  },
  npm: {
    interfaceName: "PitNpmCapability",
    documentation:
      "npm.run, npm.test, npm.install, npm.audit, npm.outdated, and npm.pack provide typed bounded npm workflows",
    methods: {
      run: {
        callDescription: "Run an npm script",
        resultRenderer: "npm.run",
        declaration:
          "run(script: string, args?: string[], options?: PitProcessOptions): Promise<PitProcessResult>;",
        documentation:
          "npm.run(script, args?, options?) runs a package script with argument-safe args",
        minimumArguments: 1,
        maximumArguments: 3,
      },
      test: {
        callDescription: "Run npm tests",
        resultRenderer: "npm.test",
        declaration: "test(options?: PitNpmTestOptions): Promise<PitProcessResult>;",
        documentation:
          "npm.test({ args?, coverage?, ...processOptions }?) runs test or coverage scripts",
        minimumArguments: 0,
        maximumArguments: 1,
      },
      install: {
        callDescription: "Install npm packages",
        resultRenderer: "npm.install",
        declaration:
          "install(packages?: string[], options?: PitNpmInstallOptions): Promise<PitProcessResult>;",
        documentation:
          "npm.install(packages?, { dev?, exact?, packageLockOnly?, ignoreScripts?, ...processOptions }?)",
        minimumArguments: 0,
        maximumArguments: 2,
      },
      audit: {
        callDescription: "Audit npm dependencies",
        resultRenderer: "npm.audit",
        declaration: "audit(options?: PitNpmAuditOptions): Promise<PitProcessResult>;",
        documentation: "npm.audit({ omitDev?, ...processOptions }?) uses bounded JSON output",
        minimumArguments: 0,
        maximumArguments: 1,
      },
      outdated: {
        callDescription: "Inspect outdated npm packages",
        resultRenderer: "npm.outdated",
        declaration: "outdated(options?: PitProcessOptions): Promise<PitProcessResult>;",
        documentation: "npm.outdated(options?) uses bounded JSON output",
        minimumArguments: 0,
        maximumArguments: 1,
      },
      pack: {
        callDescription: "Inspect npm package contents",
        resultRenderer: "npm.pack",
        declaration: "pack(options?: PitNpmPackOptions): Promise<PitProcessResult>;",
        documentation: "npm.pack({ dryRun?: true, ...processOptions }?) defaults to a JSON dry run",
        minimumArguments: 0,
        maximumArguments: 1,
      },
    },
  },

  shell: {
    interfaceName: "PitShellCapability",
    methods: {
      execFile: {
        callDescription: "Run command",
        resultRenderer: "shell",
        declaration:
          "execFile(program: string, args: string[], options?: PitProcessOptions): Promise<PitProcessResult>;",
        documentation:
          'shell.execFile(program, args, { cwd?, timeoutMs?, raise?, maxBytes?, maxLines?, truncate?: "head" | "tail" }) for bounded argument-safe execution',
        minimumArguments: 2,
        maximumArguments: 3,
      },
      exec: {
        callDescription: "Run shell command",
        resultRenderer: "shell",
        declaration:
          "exec(command: string, options?: PitProcessOptions): Promise<PitProcessResult>;",
        documentation:
          'shell.exec(command, { cwd?, timeoutMs?, raise?, maxBytes?, maxLines?, truncate?: "head" | "tail" }) for shell syntax; methods return { stdout, stderr, code, truncated }; Nonzero exits are data by default, and { raise: true } throws',
        minimumArguments: 1,
        maximumArguments: 2,
      },
    },
  },
  http: {
    interfaceName: "PitHttpCapability",
    methods: {
      request: {
        callDescription: "Request remote data",
        resultRenderer: "http",
        declaration: `request(
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
}>;`,
        documentation:
          "http.request(url, { maxBytes?, ... }) -> { status, ok, headers, body, truncated }",
        minimumArguments: 1,
        maximumArguments: 2,
      },
    },
  },
  ui: {
    interfaceName: "PitUiCapability",
    methods: {
      confirm: {
        callDescription: "Confirm with the operator",
        declaration: "confirm(title: string, message: string): Promise<boolean>;",
        documentation: "ui.confirm(title, message)",
        minimumArguments: 2,
        maximumArguments: 2,
      },
      input: {
        callDescription: "Request operator input",
        declaration: "input(title: string, placeholder?: string): Promise<string | undefined>;",
        documentation: "ui.input(title, placeholder?)",
        minimumArguments: 1,
        maximumArguments: 2,
      },
      select: {
        callDescription: "Ask the operator to select",
        declaration: "select(title: string, options: string[]): Promise<string | undefined>;",
        documentation: "ui.select(title, options)",
        minimumArguments: 2,
        maximumArguments: 2,
      },
      notify: {
        callDescription: "Notify the operator",
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
        callDescription: "Inspect session context",
        declaration: `get(): Promise<{
  cwd: string;
  mode: string;
  model: string | undefined;
  thinkingLevel: string;
  sessionFile: string | undefined;
  savedFunctions: string[];
  projectFunctions: string[];
  sessionFunctions: string[];
  projectFunctionsEnabled: boolean;
}>;`,
        documentation:
          "context.get() -> cwd, mode, model, thinkingLevel, sessionFile, savedFunctions, projectFunctions, sessionFunctions, projectFunctionsEnabled",
        minimumArguments: 0,
        maximumArguments: 0,
      },
    },
  },
  functions: {
    interfaceName: "PitFunctionsCapability",
    methods: {
      list: {
        callDescription: "List project functions",
        declaration: "list(): Promise<PitProjectFunctionMetadata[]>;",
        documentation: "functions.list() lists trusted project-persisted functions",
        minimumArguments: 0,
        maximumArguments: 0,
      },
      get: {
        callDescription: "Inspect a project function",
        declaration: "get(name: string): Promise<PitProjectFunctionMetadata & { source: string }>;",
        documentation: "functions.get(name) returns project function metadata and source",
        minimumArguments: 1,
        maximumArguments: 1,
      },
      remove: {
        callDescription: "Remove a project function",
        declaration: "remove(name: string): Promise<{ name: string; removed: boolean }>;",
        documentation: "functions.remove(name) removes a trusted project-persisted function",
        minimumArguments: 1,
        maximumArguments: 1,
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
    const documentation =
      "documentation" in definition
        ? definition.documentation
        : Object.values(definition.methods)
            .map((method) => method.documentation)
            .join("; ");
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
  return `${CAPABILITY_CONTRACT_PREAMBLE}\n\n${interfaces}\n\ninterface PitCapabilities {\n${capabilities}\n}\n\ntype PitSavedInput<T extends (...args: any[]) => any> =\n  Parameters<T> extends [any, ...infer Rest] ? Rest[0] : undefined;\n\ntype PitProgram = (\n  capabilities: PitCapabilities,\n  input?: any,\n) => PitResult | void | Promise<PitResult | void>;\n`;
}
