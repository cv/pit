import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerFunctionManager } from "../../src/functions/manager.js";
import {
  effectiveRegistry,
  reconstructFunctions,
  validateRegistryCapacity,
} from "../../src/index.js";
import { savedFunctionCatalogNotice } from "../../src/tool/typescript.js";
import { cleanupHarness, context, setupHarness } from "../support/extension-fixture.js";

beforeEach(setupHarness);
afterEach(cleanupHarness);

describe("function registry handler", () => {
  it("bounds saved function count and aggregate source size", () => {
    expect(() => validateRegistryCapacity(new Map(), "large", "x".repeat(100_001))).toThrow(
      "saved function source exceeds",
    );

    const full = new Map(Array.from({ length: 64 }, (_, index) => [`fn${index}`, "x"]));
    expect(() => validateRegistryCapacity(full, "extra", "x")).toThrow("limited to 64 functions");
    expect(() => validateRegistryCapacity(full, "fn0", "replacement")).not.toThrow();

    const aggregate = new Map(
      Array.from({ length: 10 }, (_, index) => [`fn${index}`, "x".repeat(100_000)]),
    );
    expect(() => validateRegistryCapacity(aggregate, "fn0", "x".repeat(100_000))).not.toThrow();
    expect(() => validateRegistryCapacity(aggregate, "extra", "x")).toThrow(
      "exceeds 976.6KB total source",
    );
  });

  it("bounds session catalogs by complete signatures", () => {
    const functions = new Map(
      Array.from({ length: 64 }, (_, index) => {
        const name = `catalogFunction${String(index).padStart(2, "0")}${"x".repeat(40)}`;
        return [name, `async function ${name}() { return true; }`] as const;
      }),
    );
    const catalog = savedFunctionCatalogNotice(functions);

    expect(Buffer.byteLength(catalog)).toBeLessThanOrEqual(1200);
    expect(catalog).toMatch(/^\n\[Session functions: catalogFunction00x+\(\)/);
    expect(catalog).toMatch(/, … \d+ more\]$/);
    const entries = catalog.slice("\n[Session functions: ".length, -1).split(", ");
    expect(entries.slice(0, -1).every((entry) => /^catalogFunction\d{2}x+\(\)$/.test(entry))).toBe(
      true,
    );
  });

  it("applies capacity to the effective project and session registry", () => {
    const project = new Map(
      Array.from({ length: 63 }, (_, index) => [`projectSlot${index}`, "project"]),
    );
    const session = new Map([
      ["projectSlot0", "session override"],
      ["sessionSlot", "session"],
    ]);
    const effective = effectiveRegistry(project, session);

    expect(effective).toHaveLength(64);
    expect(effective.get("projectSlot0")).toBe("session override");
    expect(() => validateRegistryCapacity(effective, "overflowSlot", "overflow")).toThrow(
      "limited to 64 functions",
    );
    expect(() => validateRegistryCapacity(effective, "sessionSlot", "replacement")).not.toThrow();
  });
  it("reconstructs valid branch-local function mutations", () => {
    const functions = new Map<string, string>();
    const source = `() => "saved"`;
    reconstructFunctions(functions, [
      null,
      { type: "custom", customType: "other", data: {} },
      { type: "custom", customType: "pit-functions", data: null },
      { type: "custom", customType: "pit-functions", data: { name: "bad name", source } },
      { type: "custom", customType: "pit-functions", data: { name: 42, source } },
      { type: "custom", customType: "pit-functions", data: { name: "missing-source", source: 42 } },
      { type: "custom", customType: "pit-functions", data: { name: "stale", source: "() => 1n" } },
      { type: "custom", customType: "pit-functions", data: { name: "active", source } },
      { type: "custom", customType: "pit-functions", data: { name: "active", deleted: true } },
      { type: "custom", customType: "pit-functions", data: { name: "remaining", source } },
    ]);
    expect([...functions.keys()]).toEqual(["remaining"]);
  });

  it("supports function managers without optional project callbacks", async () => {
    let command: { handler: (args: string, ctx: any) => Promise<void> } | undefined;
    const pi = {
      appendEntry: vi.fn(),
      registerCommand: (_name: string, registered: typeof command) => {
        command = registered;
      },
    };

    const sessionFunctions = new Map([
      ["sessionOnly", "async function sessionOnly() { return true; }"],
    ]);
    registerFunctionManager(pi as any, sessionFunctions, {
      planSessionRemoval: (name) => ({
        directDependents: [],
        transitiveDependents: [],
        removalClosure: [name],
      }),
      removeSession: async (name) => {
        sessionFunctions.delete(name);
        return [name];
      },
    });
    const sessionCtx = context({ mode: "tui" });
    sessionCtx.ui.select = vi
      .fn()
      .mockImplementationOnce(async (_title: string, options: string[]) => options[0])
      .mockImplementationOnce(async (_title: string, options: string[]) => {
        expect(options).toEqual(["Inspect source", "Delete", "Close"]);
        return "Close";
      });
    await command?.handler("", sessionCtx);

    registerFunctionManager(pi as any, new Map(), {
      projectFunctions: new Map([
        ["projectOnly", "/** Project only. @pit project */ async function projectOnly() {}"],
      ]),
      planSessionRemoval: (name) => ({
        directDependents: [],
        transitiveDependents: [],
        removalClosure: [name],
      }),
      removeSession: async (name) => [name],
    });
    const projectCtx = context({ mode: "tui" });
    projectCtx.ui.select = vi
      .fn()
      .mockImplementationOnce(async (_title: string, options: string[]) => options[0])
      .mockImplementationOnce(async (_title: string, options: string[]) => {
        expect(options).toEqual(["Inspect source", "Close"]);
        return "Close";
      });
    await command?.handler("", projectCtx);
  });
});
