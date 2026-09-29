import { defineNativeFunction } from "../global-definition.js";

export const workspaceFunctions = [
  defineNativeFunction("workspace", "viewImage", {
    summary: "Display a workspace image",
    declaration:
      "viewImage(file: string): Promise<{ file: string; mimeType: string; queued: true }>;",
    documentation:
      "workspace.viewImage(file): one successful image per TypeScript invocation; failed calls can retry.",
    minimumArguments: 1,
    maximumArguments: 1,
  }),

  defineNativeFunction("workspace", "read", {
    summary: "Read workspace files",
    resultRenderer: "read",
    declaration: `read(
  file: string,
  options?: { format?: PitReadFormat; offset?: number; limit?: number },
): Promise<PitReadResult>;`,
    documentation:
      'workspace.read(file, { format?: "hashed" | "raw", offset?, limit? }) defaults to hashed line:hash anchors and sparse metadata',
    minimumArguments: 1,
    maximumArguments: 2,
  }),
  defineNativeFunction("workspace", "edit", {
    summary: "Edit workspace files",
    resultRenderer: "edit",
    declaration: "edit(file: string, changes: PitEditChangeSpec): Promise<PitEditResult>;",
    documentation:
      'workspace.edit(file, { revision, changes }); replace/delete use "start"/optional "end", insertBefore/insertAfter use "anchor", and replaceFile/deleteFile need no anchor',
    minimumArguments: 2,
    maximumArguments: 2,
  }),
  defineNativeFunction("workspace", "batch", {
    summary: "Run workspace batch",
    resultRenderer: "batch",
    // Failure handling applies only to read batches; the runtime rejects options for edits.
    declaration: `batch(
  operations: PitBatchReadOperation[],
  options?: { failure?: "fail-fast" | "settled" },
): Promise<{
  results: Array<
    | { kind: "read"; index: number; ok: true; value: PitReadResult }
    | { kind: "read"; index: number; ok: false; value?: undefined; error: string }
  >;
}>;
batch(
  operations: PitBatchEditOperation[],
): Promise<{ results: Array<{ kind: "edit"; index: number; ok: true; value: PitEditResult }> }>;
batch(operations: PitBatchOperation[]): Promise<{
  results: Array<
    | { kind: "read"; index: number; ok: true; value: PitReadResult }
    | { kind: "read"; index: number; ok: false; value?: undefined; error: string }
    | { kind: "edit"; index: number; ok: true; value: PitEditResult }
  >;
}>;`,
    documentation:
      'workspace.batch runs homogeneous reads [{ kind: "read", file, options? }], optionally with { failure?: "fail-fast" | "settled" }, or edits [{ kind: "edit", file, changes: { revision, changes } }] without options; both return ordered { results }',
    minimumArguments: 1,
    maximumArguments: 2,
  }),
  defineNativeFunction("workspace", "list", {
    summary: "List workspace entries",
    resultRenderer: "list",
    declaration: "list(path?: string): Promise<PitWorkspaceEntry[]>;",
    documentation: "workspace.list(path?)",
    minimumArguments: 0,
    maximumArguments: 1,
  }),
  defineNativeFunction("workspace", "glob", {
    summary: "List matching files",
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
  }),
  defineNativeFunction("workspace", "search", {
    summary: "Search workspace",
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
  hint?: string;
}>;`,
    documentation:
      "workspace.search(query, { path?, glob?, regex?, caseSensitive?, contextLines?: 0..10, limit?: 1..500, ignore?, dot? }) returns edit-ready anchors and revisions",
    minimumArguments: 1,
    maximumArguments: 2,
  }),
  defineNativeFunction("workspace", "stat", {
    summary: "Inspect file metadata",
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
  }),
] as const;
