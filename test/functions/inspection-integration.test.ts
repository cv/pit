import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cleanupHarness,
  context,
  cwd,
  functionsCommand,
  run,
  runWithParams,
  sessionStart,
  setupHarness,
  tool,
  value,
} from "../support/extension-fixture.js";

beforeEach(setupHarness);
afterEach(cleanupHarness);

describe("complete function registry management", () => {
  it("exposes native globals through the same listing and inspection APIs", async () => {
    await sessionStart({}, context());
    const info = await value("async ({ context: { get } }) => get()");
    expect(info.globalFunctions).toContain("workspace.read");
    const defaultPage = await value("async ({ functions: { listAll } }) => listAll()");
    expect(defaultPage).toMatchObject({ offset: 0, nextOffset: 50 });
    const page = await value(
      'async ({ functions: { listAll } }) => listAll({ scope: "global", limit: 2 })',
    );
    expect(page.functions).toHaveLength(2);
    expect(page.total).toBe(info.globalFunctions.length);
    expect(page.nextOffset).toBe(2);
    const definition = await value(
      'async ({ functions: { getSaved } }) => getSaved("workspace.read", "global")',
    );
    expect(definition).toMatchObject({
      kind: "native",
      scope: "global",
      readOnly: true,
      effects: ["workspace.read"],
    });
    expect(definition).not.toHaveProperty("source");
    await expect(
      value('async ({ functions: { planRemoval } }) => planRemoval("workspace.read")'),
    ).rejects.toThrow("Global functions are immutable");
    await expect(
      value('async ({ functions: { planRemoval } }) => planRemoval("workspace.read", "global")'),
    ).rejects.toThrow("Global functions are immutable");
  });

  it("inspects the selected lower definition instead of silently returning the override", async () => {
    await tool.execute(
      "override",
      {
        functionId: "context.get",
        code: "async function get({ $next }) { return $next(); }",
        saveOnly: true,
      },
      undefined,
      undefined,
      context(),
    );
    const effective = await value('async ({ functions: { getSaved } }) => getSaved("context.get")');
    expect(effective).toMatchObject({
      scope: "session",
      kind: "source",
      overridesGlobal: true,
      next: { scope: "global" },
      effects: ["context.get"],
    });
    const lower = await value(
      'async ({ functions: { getSaved } }) => getSaved("context.get", "global")',
    );
    expect(lower).toMatchObject({
      scope: "global",
      kind: "native",
      effective: false,
      effectiveScope: "session",
      readOnly: true,
    });
    const all = await value(
      'async ({ functions: { listAll } }) => (await listAll({ allDefinitions: true, limit: 200 })).functions.filter(entry => entry.name === "context.get")',
    );
    expect(all.map((entry: { scope: string }) => entry.scope)).toEqual(["session", "global"]);
  });

  it("keeps sealed management callable while reporting an invalid override attempt", async () => {
    const directory = join(cwd, "agent/functions/functions");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "listAll.ts"),
      "/** Rejected override. */ async function listAll({}) { return []; }",
    );
    await writeFile(
      join(cwd, "agent/functions/healthy.ts"),
      "/** Unrelated healthy function. */ async function healthy({}) { return 42; }",
    );
    await sessionStart({}, context());
    await expect(value("async ({ healthy }) => healthy()")).resolves.toBe(42);
    const actual = await value(
      'async ({ functions: { getSaved } }) => getSaved("functions.listAll")',
    );
    expect(actual).toMatchObject({
      scope: "global",
      kind: "native",
      effective: true,
      available: true,
      sealed: true,
    });
    const attempted = await value(
      'async ({ functions: { getSaved } }) => getSaved("functions.listAll", "user")',
    );
    expect(attempted).toMatchObject({
      scope: "user",
      kind: "invalid",
      effective: false,
      available: false,
    });
    expect(attempted.error).toContain("sealed");
    await expect(
      value(
        'async ({ functions: { listAll } }) => (await listAll({ scope: "global", limit: 1 })).functions.length',
      ),
    ).resolves.toBe(1);
  });

  it.each<{ name: string; options: unknown; error: string }>([
    { name: "unknown field", options: { extra: true }, error: "unknown fields" },
    { name: "array", options: [], error: "must be an object" },
    { name: "unknown scope", options: { scope: "machine" }, error: "function scope must" },
    {
      name: "non-boolean allDefinitions",
      options: { allDefinitions: "yes" },
      error: "must be a boolean",
    },
    { name: "string offset", options: { offset: "1" }, error: "offset must be a number" },
    { name: "string limit", options: { limit: "1" }, error: "limit must be a number" },
    { name: "negative offset", options: { offset: -1 }, error: "offset must be non-negative" },
    { name: "oversized limit", options: { limit: 201 }, error: "limit must be 1–200" },
  ])("rejects $name listing options", async ({ options, error }) => {
    await expect(
      runWithParams(
        "async ({ functions: { listAll } }, input: unknown) => listAll(input as any)",
        options,
      ),
    ).rejects.toThrow(error);
  });

  it("shows native metadata with bounded width and no mutation controls", async () => {
    const ctx = context({ mode: "tui" });
    await functionsCommand.handler("show functions.promote global", ctx);
    const factory = (ctx.ui.custom.mock.calls as unknown[][])[0]?.[0] as any;
    const close = vi.fn();
    const component = factory(
      {},
      { fg: (_color: string, text: string) => text, bold: (text: string) => text },
      {},
      close,
    );
    const lines = component.render(200);
    expect(lines.join("\n")).toContain("Implementation: native; read-only; sealed");
    expect(lines.join("\n")).toContain("<pit builtin>");
    expect(lines.join("\n")).toContain("Transitive effects: functions.promote");
    expect(lines.join("\n")).toContain("no authored source is exposed");
    expect(component.render(12).every((line: string) => visibleWidth(line) <= 12)).toBe(true);
    component.invalidate();
    component.handleInput("q");
    expect(close).toHaveBeenCalledOnce();

    ctx.ui.select
      .mockImplementationOnce(async (_title, options) =>
        options.find((option) => option.startsWith("functions.promote [global]")),
      )
      .mockImplementationOnce(async (_title, options) => {
        expect(options).toEqual(["Inspect definition", "Close"]);
        return "Close";
      });
    await functionsCommand.handler("", ctx);
    await functionsCommand.handler("delete functions.promote", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Global functions are immutable", "error");
    expect(ctx.ui.confirm).not.toHaveBeenCalled();
  });

  it("supports scope filters, pagination, and shadowed definition selection", async () => {
    await run("async function authored({}) { return 1; }");
    const ctx = context({ mode: "tui" });
    ctx.ui.select
      .mockResolvedValueOnce("Next page")
      .mockResolvedValueOnce("Previous page")
      .mockResolvedValueOnce("Show all definitions")
      .mockResolvedValueOnce("Filter scope…")
      .mockResolvedValueOnce("All scopes")
      .mockResolvedValueOnce("Show effective definitions")
      .mockResolvedValueOnce("Filter scope…")
      .mockResolvedValueOnce("user")
      .mockResolvedValueOnce("Filter scope…")
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce("Filter scope…")
      .mockResolvedValueOnce("session")
      .mockImplementationOnce(async (_title, options) =>
        options.find((option) => option.startsWith("authored [session]")),
      )
      .mockResolvedValueOnce("Inspect source")
      .mockResolvedValueOnce(undefined);
    await functionsCommand.handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("No functions match this view", "info");
    expect(ctx.ui.custom).toHaveBeenCalledOnce();
    await functionsCommand.handler("list global", ctx);
    expect(ctx.ui.notify.mock.calls.at(-1)?.[0]).toContain("[global]");
    await functionsCommand.handler("list user", ctx);
    expect(ctx.ui.notify.mock.calls.at(-1)?.[0]).toBe("No functions match this view");
    await functionsCommand.handler("list session", ctx);
    expect(ctx.ui.notify.mock.calls.at(-1)?.[0]).toContain("authored [session]");
    await functionsCommand.handler("list all", ctx);
    expect(ctx.ui.notify.mock.calls.at(-1)?.[0]).toContain("authored [session]");
  });

  it("does not honor forged mutation actions when inspecting a global beneath a session override", async () => {
    await tool.execute(
      "override",
      {
        functionId: "context.get",
        code: "async function get({ $next }) { return $next(); }",
        saveOnly: true,
      },
      undefined,
      undefined,
      context(),
    );
    const ctx = context({ mode: "tui" });
    ctx.ui.select
      .mockResolvedValueOnce("Filter scope…")
      .mockResolvedValueOnce("global")
      .mockImplementationOnce(async (_title, options) =>
        options.find((option) => option.startsWith("context.get [global shadowed]")),
      )
      .mockResolvedValueOnce("Delete")
      .mockResolvedValueOnce(undefined);
    await functionsCommand.handler("", ctx);
    expect((await value("async ({ context: { get } }) => get()")).sessionFunctions).toContain(
      "context.get",
    );
    expect(ctx.ui.confirm).not.toHaveBeenCalled();
  });
});
