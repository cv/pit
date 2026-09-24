import { defineCapability } from "./core.js";

export const workspaceCapability = defineCapability({
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
});
