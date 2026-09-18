import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatSize } from "@earendil-works/pi-coding-agent";

import type { FunctionRegistry, FunctionScope, SessionFunctionRemovalPlan } from "./core.js";
import { FunctionInspector, type FunctionSummary, type FunctionListOptions } from "./inspection.js";
import { FUNCTION_LAYERS } from "./layered-registry.js";
import { FunctionViewer } from "./viewer.js";

const COMMAND_ARGUMENTS_PATTERN = /\s+/;
const FILTER_LABEL = "Filter scope…";
const ALL_LABEL = "Show all definitions";
const EFFECTIVE_LABEL = "Show effective definitions";

function scopeValue(value: string | undefined): FunctionScope | undefined {
  return value && FUNCTION_LAYERS.includes(value as FunctionScope)
    ? (value as FunctionScope)
    : undefined;
}

function entryLabel(entry: FunctionSummary): string {
  const override = entry.overridesProject || entry.overridesUser || entry.overridesGlobal;
  const scope = entry.scope + (override ? " override" : "") + (entry.effective ? "" : " shadowed");
  const detail =
    entry.kind === "source"
      ? `${entry.lines} lines, ${formatSize(entry.bytes)}`
      : `${entry.kind}, read-only${entry.sealed ? ", sealed" : ""}`;
  return `${entry.name} [${scope}] — ${detail}`;
}

export interface FunctionManagerOptions {
  userFunctions?: FunctionRegistry;
  projectFunctions?: FunctionRegistry;
  invalidUser?: ReadonlyMap<string, string>;
  invalidProject?: ReadonlyMap<string, string>;
  planSessionRemoval(name: string): SessionFunctionRemovalPlan;
  removeSession(name: string): Promise<string[]>;
  saveToProject?: (name: string, ctx: ExtensionContext) => Promise<void>;
  saveToUser?: (name: string, ctx: ExtensionContext) => Promise<void>;
  removeFromProject?: (name: string, ctx: ExtensionContext) => Promise<void>;
  removeFromUser?: (name: string, ctx: ExtensionContext) => Promise<void>;
}

class SavedFunctionManager {
  readonly #userFunctions: FunctionRegistry;
  readonly #projectFunctions: FunctionRegistry;

  constructor(
    private readonly savedFunctions: FunctionRegistry,
    private readonly options: FunctionManagerOptions,
  ) {
    this.#userFunctions = options.userFunctions ?? new Map<string, string>();
    this.#projectFunctions = options.projectFunctions ?? new Map<string, string>();
  }

  register(pi: ExtensionAPI): void {
    pi.registerCommand("functions", {
      description: "Inspect layered functions and manage writable definitions",
      handler: (args, ctx) => this.handleCommand(args, ctx),
    });
  }

  private inspector(ctx: ExtensionContext): FunctionInspector {
    return new FunctionInspector(
      {
        user: this.#userFunctions,
        project: this.#projectFunctions,
        session: this.savedFunctions,
        ...(this.options.invalidUser ? { invalidUser: this.options.invalidUser } : {}),
        ...(this.options.invalidProject ? { invalidProject: this.options.invalidProject } : {}),
      },
      ctx.cwd,
    );
  }

  private summaries(ctx: ExtensionContext, options: FunctionListOptions = {}): FunctionSummary[] {
    return this.inspector(ctx)
      .summaries(options)
      .sort(
        (a, b) =>
          Number(a.scope === "global") - Number(b.scope === "global") ||
          a.name.localeCompare(b.name),
      );
  }

  private async inspect(name: string, ctx: ExtensionContext, scope?: FunctionScope): Promise<void> {
    try {
      const definition = this.inspector(ctx).inspect(name, scope);
      if (ctx.mode !== "tui") {
        ctx.ui.notify("Function inspection requires TUI mode", "error");
        return;
      }
      await ctx.ui.custom<void>(
        (_tui, theme, _keybindings, done) => new FunctionViewer(definition, theme, () => done()),
      );
    } catch (error) {
      ctx.ui.notify((error as Error).message, "error");
    }
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

  private list(ctx: ExtensionContext, options: FunctionListOptions = {}): void {
    const entries = this.summaries(ctx, options);
    const shown = entries.slice(0, 50);
    const message = shown.length
      ? shown.map(entryLabel).join("\n")
      : "No functions match this view";
    ctx.ui.notify(
      message +
        (shown.length < entries.length
          ? `\n… ${entries.length - shown.length} more; use /functions for pagination and scope filters`
          : ""),
      "info",
    );
  }

  private actions(entry: FunctionSummary): string[] {
    if (entry.readOnly) return ["Inspect definition", "Close"];
    if (entry.scope === "session") {
      return [
        "Inspect source",
        ...(this.options.saveToProject ? ["Save to project"] : []),
        ...(this.options.saveToUser ? ["Save to user scope"] : []),
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
      ...(this.options.removeFromUser ? ["Remove from user scope"] : []),
      "Close",
    ];
  }

  private async handleAction(entry: FunctionSummary, ctx: ExtensionContext): Promise<boolean> {
    const allowed = this.actions(entry);
    const action = await ctx.ui.select(entry.name, allowed);
    if (action === "Close" || action === undefined) {
      return true;
    }
    if (!allowed.includes(action)) return false;
    if (action === "Inspect source" || action === "Inspect definition") {
      await this.inspect(entry.name, ctx, entry.scope);
    } else if (action === "Save to project" && this.options.saveToProject) {
      await this.runProjectAction(() => this.options.saveToProject?.(entry.name, ctx), ctx);
    } else if (action === "Save to user scope" && this.options.saveToUser) {
      await this.runProjectAction(() => this.options.saveToUser?.(entry.name, ctx), ctx);
    } else if (action === "Remove from project" && this.options.removeFromProject) {
      await this.runProjectAction(() => this.options.removeFromProject?.(entry.name, ctx), ctx);
    } else if (action === "Remove from user scope" && this.options.removeFromUser) {
      await this.runProjectAction(() => this.options.removeFromUser?.(entry.name, ctx), ctx);
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
    let options: FunctionListOptions = {};
    let offset = 0;
    for (;;) {
      const entries = this.summaries(ctx, options);
      const page = entries.slice(offset, offset + 50);
      const toggle = options.allDefinitions ? EFFECTIVE_LABEL : ALL_LABEL;
      const labels = [
        ...page.map(entryLabel),
        ...(offset ? ["Previous page"] : []),
        ...(offset + page.length < entries.length ? ["Next page"] : []),
        FILTER_LABEL,
        toggle,
      ];
      if (!entries.length) ctx.ui.notify("No functions match this view", "info");
      const selected = await ctx.ui.select("Functions", labels);
      if (selected === undefined) return;
      if (selected === FILTER_LABEL) {
        const scope = await ctx.ui.select("Function scope", ["All scopes", ...FUNCTION_LAYERS]);
        if (scope === undefined) continue;
        options = {
          ...(options.allDefinitions ? { allDefinitions: true } : {}),
          ...(scopeValue(scope) ? { scope: scopeValue(scope) as FunctionScope } : {}),
        };
        offset = 0;
      } else if (selected === toggle) {
        options = { ...options, allDefinitions: !options.allDefinitions };
        offset = 0;
      } else if (selected === "Next page") {
        offset += 50;
      } else if (selected === "Previous page") {
        offset = Math.max(0, offset - 50);
      } else {
        const entry = page[labels.indexOf(selected)];
        if (!entry || (await this.handleAction(entry, ctx))) return;
        offset = 0;
      }
    }
  }

  private async handleCommand(args: string, ctx: ExtensionContext): Promise<void> {
    const [action = "", name, requestedScope, extra] = args.trim().split(COMMAND_ARGUMENTS_PATTERN);
    const scope = scopeValue(requestedScope);
    if (!action) {
      if (ctx.mode === "tui") await this.interactive(ctx);
      else this.list(ctx);
      return;
    }
    if (action === "list" && !requestedScope && (!name || name === "all" || scopeValue(name))) {
      this.list(
        ctx,
        name === "all"
          ? { allDefinitions: true }
          : name
            ? { scope: scopeValue(name) as FunctionScope }
            : {},
      );
    } else if (action === "show" && name && !extra && (!requestedScope || scope)) {
      await this.inspect(name, ctx, scope);
    } else if (action === "delete" && name && !requestedScope) {
      if (
        !this.savedFunctions.has(name) &&
        this.inspector(ctx)
          .summaries({ scope: "global" })
          .some((entry) => entry.name === name)
      ) {
        ctx.ui.notify("Global functions are immutable", "error");
        return;
      }
      await this.delete(name, ctx);
    } else {
      ctx.ui.notify(
        "Usage: /functions [list [all|scope] | show <name> [scope] | delete <name>]",
        "error",
      );
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
