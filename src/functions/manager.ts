import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { formatSize, highlightCode } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

import type { FunctionRegistry, FunctionScope, SessionFunctionRemovalPlan } from "./core.js";

const COMMAND_ARGUMENTS_PATTERN = /\s+/;

interface FunctionSummary {
  name: string;
  source: string;
  scope: FunctionScope;
  scopeLabel: string;
  lines: number;
  bytes: number;
}

export interface FunctionManagerOptions {
  globalFunctions?: FunctionRegistry;
  projectFunctions?: FunctionRegistry;
  planSessionRemoval(name: string): SessionFunctionRemovalPlan;
  removeSession(name: string): Promise<string[]>;
  saveToProject?: (name: string, ctx: ExtensionContext) => Promise<void>;
  saveToGlobal?: (name: string, ctx: ExtensionContext) => Promise<void>;
  removeFromProject?: (name: string, ctx: ExtensionContext) => Promise<void>;
  removeFromGlobal?: (name: string, ctx: ExtensionContext) => Promise<void>;
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

class SavedFunctionManager {
  readonly #globalFunctions: FunctionRegistry;
  readonly #projectFunctions: FunctionRegistry;

  constructor(
    private readonly savedFunctions: FunctionRegistry,
    private readonly options: FunctionManagerOptions,
  ) {
    this.#globalFunctions = options.globalFunctions ?? new Map<string, string>();
    this.#projectFunctions = options.projectFunctions ?? new Map<string, string>();
  }

  register(pi: ExtensionAPI): void {
    pi.registerCommand("functions", {
      description: "List and manage saved TypeScript functions",
      handler: (args, ctx) => this.handleCommand(args, ctx),
    });
  }

  private summaries(): FunctionSummary[] {
    const effective = new Map(this.#globalFunctions);
    for (const [name, source] of this.#projectFunctions) {
      effective.set(name, source);
    }
    for (const [name, source] of this.savedFunctions) {
      effective.set(name, source);
    }
    return [...effective.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, source]) => {
        const scope: FunctionScope = this.savedFunctions.has(name)
          ? "session"
          : this.#projectFunctions.has(name)
            ? "project"
            : "global";
        const overridesLower =
          scope === "session"
            ? this.#projectFunctions.has(name) || this.#globalFunctions.has(name)
            : scope === "project" && this.#globalFunctions.has(name);
        return {
          name,
          source,
          scope,
          scopeLabel: overridesLower ? `${scope} override` : scope,
          lines: source.split("\n").length,
          bytes: Buffer.byteLength(source),
        };
      });
  }

  private async inspect(name: string, ctx: ExtensionContext, scope?: FunctionScope): Promise<void> {
    const source =
      scope === "global"
        ? this.#globalFunctions.get(name)
        : scope === "project"
          ? this.#projectFunctions.get(name)
          : (this.savedFunctions.get(name) ??
            this.#projectFunctions.get(name) ??
            this.#globalFunctions.get(name));
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
  }

  private async delete(name: string, ctx: ExtensionContext): Promise<boolean> {
    if (!this.savedFunctions.has(name)) {
      ctx.ui.notify(`Saved function "${name}" was not found`, "error");
      return false;
    }
    let plan: SessionFunctionRemovalPlan;
    try {
      plan = this.options.planSessionRemoval(name);
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
    if (
      !(await ctx.ui.confirm(
        `Delete ${name}?`,
        `Delete this saved function on the active branch?${dependencyWarning}`,
      ))
    ) {
      return false;
    }
    try {
      const removed = await this.options.removeSession(name);
      ctx.ui.notify(
        `Deleted saved function${removed.length === 1 ? "" : "s"}: ${removed.join(", ")}`,
        "info",
      );
      return true;
    } catch (error) {
      ctx.ui.notify((error as Error).message, "error");
      return false;
    }
  }

  private list(ctx: ExtensionContext): void {
    const entries = this.summaries();
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
  }

  private actions(entry: FunctionSummary): string[] {
    if (entry.scope === "session") {
      return [
        "Inspect source",
        ...(this.options.saveToProject ? ["Save to project"] : []),
        ...(this.options.saveToGlobal ? ["Save globally"] : []),
        "Delete",
        "Close",
      ];
    }
    if (entry.scope === "project") {
      return [
        "Inspect source",
        ...(this.options.removeFromProject ? ["Remove from project"] : []),
        "Close",
      ];
    }
    return [
      "Inspect source",
      ...(this.options.removeFromGlobal ? ["Remove globally"] : []),
      "Close",
    ];
  }

  private async handleAction(entry: FunctionSummary, ctx: ExtensionContext): Promise<boolean> {
    const action = await ctx.ui.select(entry.name, this.actions(entry));
    if (action === "Close" || action === undefined) {
      return true;
    }
    if (action === "Inspect source") {
      await this.inspect(entry.name, ctx, entry.scope);
    } else if (action === "Save to project" && this.options.saveToProject) {
      await this.runProjectAction(() => this.options.saveToProject?.(entry.name, ctx), ctx);
    } else if (action === "Save globally" && this.options.saveToGlobal) {
      await this.runProjectAction(() => this.options.saveToGlobal?.(entry.name, ctx), ctx);
    } else if (action === "Remove from project" && this.options.removeFromProject) {
      await this.runProjectAction(() => this.options.removeFromProject?.(entry.name, ctx), ctx);
    } else if (action === "Remove globally" && this.options.removeFromGlobal) {
      await this.runProjectAction(() => this.options.removeFromGlobal?.(entry.name, ctx), ctx);
    } else if (action === "Delete") {
      await this.delete(entry.name, ctx);
    }
    return false;
  }

  private async runProjectAction(
    action: () => Promise<void> | undefined,
    ctx: ExtensionContext,
  ): Promise<void> {
    try {
      await action();
    } catch (error) {
      ctx.ui.notify((error as Error).message, "error");
    }
  }

  private async interactive(ctx: ExtensionContext): Promise<void> {
    for (;;) {
      const entries = this.summaries();
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
      const entry = entries[labels.indexOf(selected)];
      if (!entry || (await this.handleAction(entry, ctx))) {
        return;
      }
    }
  }

  private async handleCommand(args: string, ctx: ExtensionContext): Promise<void> {
    const [action = "", name] = args.trim().split(COMMAND_ARGUMENTS_PATTERN, 2);
    if (!action) {
      if (ctx.mode === "tui") {
        await this.interactive(ctx);
      } else {
        this.list(ctx);
      }
      return;
    }
    if (action === "list") {
      this.list(ctx);
    } else if (action === "show" && name) {
      await this.inspect(name, ctx);
    } else if (action === "delete" && name) {
      await this.delete(name, ctx);
    } else {
      ctx.ui.notify("Usage: /functions [list | show <name> | delete <name>]", "error");
    }
  }
}

export function registerFunctionManager(
  pi: ExtensionAPI,
  savedFunctions: FunctionRegistry,
  options: FunctionManagerOptions,
): void {
  new SavedFunctionManager(savedFunctions, options).register(pi);
}
