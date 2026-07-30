import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { formatSize, highlightCode } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { resolveSavedFunctionReferences, validateTypeScript } from "./sandbox.js";

const MAX_SAVED_FUNCTION_BYTES = 100_000;
const MAX_SAVED_FUNCTIONS = 64;
const MAX_SAVED_FUNCTION_TOTAL_BYTES = 1_000_000;
const SAVED_FUNCTION_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
const RESERVED_FUNCTION_NAMES = new Set([
  "Array", "Boolean", "Date", "Error", "Infinity", "JSON", "Map", "Math",
  "NaN", "Number", "Object", "Promise", "RegExp", "Set", "String",
  "console", "eval", "globalThis", "process", "undefined",
]);

export type FunctionRegistry = Map<string, string>;
export const FUNCTION_ENTRY_TYPE = "pit-functions";
export type FunctionEntry =
  | { name: string; source: string; deleted?: never }
  | { name: string; deleted: true; source?: never };
export interface FunctionActivity {
  action: "set" | "run";
  name: string;
  replaced?: boolean;
}
export function validateRegistryCapacity(
  registry: ReadonlyMap<string, string>,
  name: string,
  source: string,
): void {
  const sourceBytes = Buffer.byteLength(source);
  if (sourceBytes > MAX_SAVED_FUNCTION_BYTES) {
    throw new Error(`saved function source exceeds ${formatSize(MAX_SAVED_FUNCTION_BYTES)}`);
  }
  if (!registry.has(name) && registry.size >= MAX_SAVED_FUNCTIONS) {
    throw new Error(`saved function registry is limited to ${MAX_SAVED_FUNCTIONS} functions`);
  }
  const previousBytes = Buffer.byteLength(registry.get(name) ?? "");
  const currentBytes = [...registry.values()].reduce((total, value) => total + Buffer.byteLength(value), 0);
  if (currentBytes - previousBytes + sourceBytes > MAX_SAVED_FUNCTION_TOTAL_BYTES) {
    throw new Error(`saved function registry exceeds ${formatSize(MAX_SAVED_FUNCTION_TOTAL_BYTES)} total source`);
  }
}

export function validateSavedFunctionName(name: string): void {
  if (!SAVED_FUNCTION_NAME.test(name) || name.startsWith("__pit") || RESERVED_FUNCTION_NAMES.has(name)) {
    throw new Error(
      "saved function name must be a non-reserved TypeScript identifier of at most 64 characters",
    );
  }
}

class SavedFunctionViewer {
  private readonly lines: string[];
  private readonly omitted: number;

  constructor(private readonly name: string, source: string, private readonly theme: Theme, private readonly close: () => void) {
    const highlighted = highlightCode(source, "typescript");
    this.lines = highlighted.slice(0, 500);
    this.omitted = highlighted.length - this.lines.length;
  }

  render(width: number): string[] {
    return [
      truncateToWidth(this.theme.fg("toolTitle", this.theme.bold(this.name)), width),
      "",
      ...this.lines.map((line) => truncateToWidth(line, width)),
      ...(this.omitted ? [this.theme.fg("muted", `… ${this.omitted} source lines omitted`)] : []),
      "",
      truncateToWidth(this.theme.fg("dim", "Enter/Esc/q to close"), width),
    ];
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, "enter") || matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") {
      this.close();
    }
  }
}

export function reconstructFunctions(
  registry: FunctionRegistry,
  entries: readonly unknown[],
): void {
  registry.clear();
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as { type?: unknown; customType?: unknown; data?: unknown };
    if (entry.type !== "custom" || entry.customType !== FUNCTION_ENTRY_TYPE) continue;
    if (!entry.data || typeof entry.data !== "object") continue;
    const definition = entry.data as Partial<FunctionEntry>;
    if (typeof definition.name !== "string") continue;
    try {
      validateSavedFunctionName(definition.name);
      if (definition.deleted === true) {
        registry.delete(definition.name);
        continue;
      }
      if (typeof definition.source !== "string") continue;
      validateRegistryCapacity(registry, definition.name, definition.source);
      validateTypeScript(definition.source, registry);
      registry.set(definition.name, definition.source);
    } catch {
      // Ignore stale or malformed persisted definitions.
    }
  }
}

export function registerFunctionManager(
  pi: ExtensionAPI,
  savedFunctions: FunctionRegistry,
): void {
const functionSummary = () => [...savedFunctions.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, source]) => ({
  name,
  source,
  lines: source.split("\n").length,
  bytes: Buffer.byteLength(source),
}));

const inspectSavedFunction = async (name: string, ctx: ExtensionContext): Promise<void> => {
  const source = savedFunctions.get(name);
  if (source === undefined) {
    ctx.ui.notify(`Saved function "${name}" was not found`, "error");
    return;
  }
  if (ctx.mode !== "tui") {
    ctx.ui.notify("Saved source inspection requires TUI mode", "error");
    return;
  }
  await ctx.ui.custom<void>((_tui, theme, _keybindings, done) =>
    new SavedFunctionViewer(name, source, theme, () => done()),
  );
};

const deleteSavedFunction = async (name: string, ctx: ExtensionContext): Promise<boolean> => {
  if (!savedFunctions.has(name)) {
    ctx.ui.notify(`Saved function "${name}" was not found`, "error");
    return false;
  }
  const namesToDelete = new Set([name]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [candidate, source] of savedFunctions) {
      if (namesToDelete.has(candidate)) continue;
      const dependsOnDeleted = resolveSavedFunctionReferences(source, savedFunctions)
        .some((reference) => namesToDelete.has(reference.name));
      if (dependsOnDeleted) { namesToDelete.add(candidate); changed = true; }
    }
  }
  const dependents = [...namesToDelete].filter((candidate) => candidate !== name).sort();
  const dependencyWarning = dependents.length ? `\n\nAlso delete dependents: ${dependents.join(", ")}` : "";
  const confirmed = await ctx.ui.confirm(
    `Delete ${name}?`,
    `Delete this saved function on the active branch?${dependencyWarning}`,
  );
  if (!confirmed) return false;
  for (const deletedName of namesToDelete) {
    savedFunctions.delete(deletedName);
    pi.appendEntry(FUNCTION_ENTRY_TYPE, { name: deletedName, deleted: true } satisfies FunctionEntry);
  }
  ctx.ui.notify(`Deleted saved function${namesToDelete.size === 1 ? "" : "s"}: ${[...namesToDelete].join(", ")}`, "info");
  return true;
};

const listSavedFunctions = (ctx: ExtensionContext): void => {
  const entries = functionSummary();
  const message = entries.length
    ? entries.map((entry) => `${entry.name} — ${entry.lines} lines, ${formatSize(entry.bytes)}`).join("\n")
    : "No saved functions on this branch";
  ctx.ui.notify(message, "info");
};

const interactiveFunctionManager = async (ctx: ExtensionContext): Promise<void> => {
  while (true) {
    const entries = functionSummary();
    if (entries.length === 0) {
      ctx.ui.notify("No saved functions on this branch", "info");
      return;
    }
    const labels = entries.map((entry) => `${entry.name} — ${entry.lines} lines, ${formatSize(entry.bytes)}`);
    const selected = await ctx.ui.select("Saved functions", labels);
    if (selected === undefined) return;
    const index = labels.indexOf(selected);
    const entry = entries[index];
    if (!entry) return;
    const action = await ctx.ui.select(entry.name, ["Inspect source", "Delete", "Close"]);
    if (action === "Inspect source") await inspectSavedFunction(entry.name, ctx);
    else if (action === "Delete") await deleteSavedFunction(entry.name, ctx);
    else if (action === "Close" || action === undefined) return;
  }
};

pi.registerCommand("functions", {
  description: "List, inspect, or delete saved TypeScript functions",
  handler: async (args, ctx) => {
    const [action = "", name] = args.trim().split(/\s+/, 2);
    if (!action) {
      if (ctx.mode === "tui") await interactiveFunctionManager(ctx);
      else listSavedFunctions(ctx);
      return;
    }
    if (action === "list") return listSavedFunctions(ctx);
    if (action === "show" && name) return inspectSavedFunction(name, ctx);
    if (action === "delete" && name) { await deleteSavedFunction(name, ctx); return; }
    ctx.ui.notify("Usage: /functions [list | show <name> | delete <name>]", "error");
  },
});

}
