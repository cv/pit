import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { formatSize, highlightCode } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { validateTypeScript } from "./sandbox.js";

const MAX_SAVED_FUNCTION_BYTES = 100_000;
const MAX_SAVED_FUNCTIONS = 64;
const MAX_SAVED_FUNCTION_TOTAL_BYTES = 1_000_000;
const SAVED_FUNCTION_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
const COMMAND_ARGUMENTS_PATTERN = /\s+/;
const RESERVED_FUNCTION_NAMES = new Set([
  "Array",
  "Boolean",
  "Date",
  "Error",
  "Infinity",
  "JSON",
  "Map",
  "Math",
  "NaN",
  "Number",
  "Object",
  "Promise",
  "RegExp",
  "Set",
  "String",
  "console",
  "eval",
  "globalThis",
  "process",
  "undefined",
]);

export type FunctionRegistry = Map<string, string>;

export function functionScopeRegistry(
  effective: ReadonlyMap<string, string>,
  session: ReadonlyMap<string, string>,
): Map<string, "project" | "session"> {
  return new Map(
    [...effective.keys()].map((name) => [name, session.has(name) ? "session" : "project"] as const),
  );
}

export function functionRunScope(
  name: string,
  project: ReadonlyMap<string, string>,
  session: ReadonlyMap<string, string>,
  attributedScope?: "project" | "session",
): "project" | "session" {
  if (attributedScope) {
    return attributedScope;
  }
  return project.has(name) && !session.has(name) ? "project" : "session";
}
export const FUNCTION_ENTRY_TYPE = "pit-functions";
export type FunctionEntry =
  | { name: string; source: string; deleted?: never }
  | { name: string; deleted: true; source?: never };
export interface FunctionActivity {
  action: "set" | "run" | "remove";
  name: string;
  replaced?: boolean;
  scope?: "project" | "session";
}
export function validateSavedFunctionSource(source: string): void {
  if (Buffer.byteLength(source) > MAX_SAVED_FUNCTION_BYTES) {
    throw new Error(`saved function source exceeds ${formatSize(MAX_SAVED_FUNCTION_BYTES)}`);
  }
}

export function validateRegistryCapacity(
  registry: ReadonlyMap<string, string>,
  name: string,
  source: string,
): void {
  validateSavedFunctionSource(source);

  const sourceBytes = Buffer.byteLength(source);
  if (!registry.has(name) && registry.size >= MAX_SAVED_FUNCTIONS) {
    throw new Error(`saved function registry is limited to ${MAX_SAVED_FUNCTIONS} functions`);
  }
  const previousBytes = Buffer.byteLength(registry.get(name) ?? "");
  const currentBytes = [...registry.values()].reduce(
    (total, value) => total + Buffer.byteLength(value),
    0,
  );
  if (currentBytes - previousBytes + sourceBytes > MAX_SAVED_FUNCTION_TOTAL_BYTES) {
    throw new Error(
      `saved function registry exceeds ${formatSize(MAX_SAVED_FUNCTION_TOTAL_BYTES)} total source`,
    );
  }
}

export function validateEffectiveRegistryCapacity(registry: ReadonlyMap<string, string>): void {
  if (registry.size > MAX_SAVED_FUNCTIONS) {
    throw new Error(`saved function registry is limited to ${MAX_SAVED_FUNCTIONS} functions`);
  }
  const totalBytes = [...registry.values()].reduce(
    (total, source) => total + Buffer.byteLength(source),
    0,
  );
  if (totalBytes > MAX_SAVED_FUNCTION_TOTAL_BYTES) {
    throw new Error(
      `saved function registry exceeds ${formatSize(MAX_SAVED_FUNCTION_TOTAL_BYTES)} total source`,
    );
  }
}

export function validateSavedFunctionName(name: string): void {
  if (
    !SAVED_FUNCTION_NAME.test(name) ||
    name.startsWith("__pit") ||
    RESERVED_FUNCTION_NAMES.has(name)
  ) {
    throw new Error(
      "saved function name must be a non-reserved TypeScript identifier of at most 64 characters",
    );
  }
}

class SavedFunctionViewer {
  private readonly lines: string[];
  private readonly omitted: number;

  constructor(
    private readonly name: string,
    source: string,
    private readonly theme: Theme,
    private readonly close: () => void,
  ) {
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

  invalidate(): void {
    // The viewer has no cached layout state.
  }

  handleInput(data: string): void {
    if (
      matchesKey(data, "enter") ||
      matchesKey(data, "escape") ||
      matchesKey(data, "ctrl+c") ||
      data === "q"
    ) {
      this.close();
    }
  }
}

export function reconstructFunctions(
  registry: FunctionRegistry,
  entries: readonly unknown[],
  baseFunctions: ReadonlyMap<string, string> = new Map(),

  capacityBaseFunctions: ReadonlyMap<string, string> = baseFunctions,
): void {
  registry.clear();
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const entry = raw as { type?: unknown; customType?: unknown; data?: unknown };
    if (entry.type !== "custom" || entry.customType !== FUNCTION_ENTRY_TYPE) {
      continue;
    }
    if (!entry.data || typeof entry.data !== "object") {
      continue;
    }
    const definition = entry.data as Partial<FunctionEntry>;
    if (typeof definition.name !== "string") {
      continue;
    }
    try {
      validateSavedFunctionName(definition.name);
      if (definition.deleted === true) {
        registry.delete(definition.name);
        continue;
      }
      if (typeof definition.source !== "string") {
        continue;
      }
      const capacityAvailable = new Map([...capacityBaseFunctions, ...registry]);
      validateRegistryCapacity(capacityAvailable, definition.name, definition.source);
      const available = new Map([...baseFunctions, ...registry]);
      available.set(definition.name, definition.source);
      validateTypeScript(definition.source, available);
      registry.set(definition.name, definition.source);
    } catch {
      // Ignore stale or malformed persisted definitions.
    }
  }
}

export interface SessionFunctionRemovalPlan {
  directDependents: string[];
  transitiveDependents: string[];
  removalClosure: string[];
}

export interface FunctionManagerOptions {
  projectFunctions?: FunctionRegistry;
  planSessionRemoval(name: string): SessionFunctionRemovalPlan;
  removeSession(name: string): Promise<string[]>;
  saveToProject?: (name: string, ctx: ExtensionContext) => Promise<void>;
  removeFromProject?: (name: string, ctx: ExtensionContext) => Promise<void>;
}

function summarizeFunctions(
  projectFunctions: ReadonlyMap<string, string>,
  savedFunctions: ReadonlyMap<string, string>,
) {
  const effective = new Map(projectFunctions);
  for (const [name, source] of savedFunctions) {
    effective.set(name, source);
  }
  return [...effective.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, source]) => {
      const scope: "session" | "project" = savedFunctions.has(name) ? "session" : "project";
      const scopeLabel =
        scope === "session" && projectFunctions.has(name) ? "session override" : scope;
      return {
        name,
        source,
        scope,
        scopeLabel,
        lines: source.split("\n").length,
        bytes: Buffer.byteLength(source),
      };
    });
}

export function registerFunctionManager(
  pi: ExtensionAPI,
  savedFunctions: FunctionRegistry,
  options: FunctionManagerOptions,
): void {
  const projectFunctions = options.projectFunctions ?? new Map<string, string>();
  const functionSummary = () => summarizeFunctions(projectFunctions, savedFunctions);

  const inspectSavedFunction = async (
    name: string,
    ctx: ExtensionContext,
    scope?: "project" | "session",
  ): Promise<void> => {
    const source =
      scope === "project"
        ? projectFunctions.get(name)
        : (savedFunctions.get(name) ?? projectFunctions.get(name));
    if (source === undefined) {
      ctx.ui.notify(`Saved function "${name}" was not found`, "error");
      return;
    }
    if (ctx.mode !== "tui") {
      ctx.ui.notify("Saved source inspection requires TUI mode", "error");
      return;
    }
    await ctx.ui.custom<void>(
      (_tui, theme, _keybindings, done) =>
        new SavedFunctionViewer(name, source, theme, () => done()),
    );
  };

  const deleteSavedFunction = async (name: string, ctx: ExtensionContext): Promise<boolean> => {
    if (!savedFunctions.has(name)) {
      ctx.ui.notify(`Saved function "${name}" was not found`, "error");
      return false;
    }
    let plan: SessionFunctionRemovalPlan;
    try {
      plan = options.planSessionRemoval(name);
    } catch (error) {
      ctx.ui.notify((error as Error).message, "error");
      return false;
    }
    const dependents = plan.removalClosure.filter((candidate) => candidate !== name);
    const dependencyKinds = [
      plan.directDependents.length > 0 ? `Direct: ${plan.directDependents.join(", ")}` : "",
      plan.transitiveDependents.length > 0
        ? `Transitive: ${plan.transitiveDependents.join(", ")}`
        : "",
    ].filter(Boolean);
    const dependencyWarning =
      dependents.length > 0
        ? `\n\nAlso delete dependents: ${dependents.join(", ")}\n${dependencyKinds.join("\n")}`
        : "";
    const confirmed = await ctx.ui.confirm(
      `Delete ${name}?`,
      `Delete this saved function on the active branch?${dependencyWarning}`,
    );
    if (!confirmed) {
      return false;
    }
    let removed: string[];
    try {
      removed = await options.removeSession(name);
    } catch (error) {
      ctx.ui.notify((error as Error).message, "error");
      return false;
    }
    ctx.ui.notify(
      `Deleted saved function${removed.length === 1 ? "" : "s"}: ${removed.join(", ")}`,
      "info",
    );
    return true;
  };

  const listSavedFunctions = (ctx: ExtensionContext): void => {
    const entries = functionSummary();
    const message =
      entries.length > 0
        ? entries
            .map(
              (entry) =>
                `${entry.name} [${entry.scopeLabel}] — ${entry.lines} lines, ${formatSize(entry.bytes)}`,
            )
            .join("\n")
        : "No saved functions";
    ctx.ui.notify(message, "info");
  };

  const handleFunctionAction = async (
    entry: ReturnType<typeof functionSummary>[number],
    ctx: ExtensionContext,
  ): Promise<boolean> => {
    const actions =
      entry.scope === "session"
        ? [
            "Inspect source",
            ...(options.saveToProject ? ["Save to project"] : []),
            "Delete",
            "Close",
          ]
        : [
            "Inspect source",
            ...(options.removeFromProject ? ["Remove from project"] : []),
            "Close",
          ];
    const action = await ctx.ui.select(entry.name, actions);
    if (action === "Close" || action === undefined) {
      return true;
    }
    if (action === "Inspect source") {
      await inspectSavedFunction(entry.name, ctx, entry.scope);
    } else if (action === "Save to project" && options.saveToProject) {
      try {
        await options.saveToProject(entry.name, ctx);
      } catch (error) {
        ctx.ui.notify((error as Error).message, "error");
      }
    } else if (action === "Remove from project" && options.removeFromProject) {
      try {
        await options.removeFromProject(entry.name, ctx);
      } catch (error) {
        ctx.ui.notify((error as Error).message, "error");
      }
    } else if (action === "Delete") {
      await deleteSavedFunction(entry.name, ctx);
    }
    return false;
  };

  const interactiveFunctionManager = async (ctx: ExtensionContext): Promise<void> => {
    for (;;) {
      const entries = functionSummary();
      if (entries.length === 0) {
        ctx.ui.notify("No saved functions", "info");
        return;
      }
      const labels = entries.map(
        (summary) =>
          `${summary.name} [${summary.scopeLabel}] — ${summary.lines} lines, ${formatSize(summary.bytes)}`,
      );
      const selected = await ctx.ui.select("Saved functions", labels);
      if (selected === undefined) {
        return;
      }
      const index = labels.indexOf(selected);
      const entry = entries[index];
      if (!entry) {
        return;
      }
      if (await handleFunctionAction(entry, ctx)) {
        return;
      }
    }
  };

  pi.registerCommand("functions", {
    description: "List and manage saved TypeScript functions",
    handler: async (args, ctx) => {
      const [action = "", name] = args.trim().split(COMMAND_ARGUMENTS_PATTERN, 2);
      if (!action) {
        if (ctx.mode === "tui") {
          await interactiveFunctionManager(ctx);
        } else {
          listSavedFunctions(ctx);
        }
        return;
      }
      if (action === "list") {
        return listSavedFunctions(ctx);
      }
      if (action === "show" && name) {
        return inspectSavedFunction(name, ctx);
      }
      if (action === "delete" && name) {
        await deleteSavedFunction(name, ctx);
        return;
      }
      ctx.ui.notify("Usage: /functions [list | show <name> | delete <name>]", "error");
    },
  });
}
