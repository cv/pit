import { describe, expect, it } from "vitest";

import {
  type FunctionLayer,
  LayeredFunctionRegistry,
} from "../../src/functions/layered-registry.js";

interface Definition {
  id: string;
  layer: FunctionLayer;
  value: string;
  sealed?: boolean;
}

function definition(id: string, layer: FunctionLayer, value: string = layer): Definition {
  return { id, layer, value };
}

describe("LayeredFunctionRegistry", () => {
  it("resolves session, project, user, and global precedence", () => {
    const registry = new LayeredFunctionRegistry<Definition>();
    for (const layer of ["global", "user", "project", "session"] as const) {
      registry.set(definition("workspace.read", layer));
    }

    expect(registry.resolve("workspace.read")?.value).toBe("session");
    expect(registry.chain("workspace.read").map(({ layer }) => layer)).toEqual([
      "session",
      "project",
      "user",
      "global",
    ]);
    expect(registry.resolveNext("workspace.read", "session")?.layer).toBe("project");
    expect(registry.resolveNext("workspace.read", "project")?.layer).toBe("user");
    expect(registry.resolveNext("workspace.read", "user")?.layer).toBe("global");
  });

  it("skips absent layers when resolving next", () => {
    const registry = new LayeredFunctionRegistry<Definition>();
    registry.set(definition("npm.test", "global"));
    registry.set(definition("npm.test", "session"));

    expect(registry.resolveNext("npm.test", "session")?.layer).toBe("global");
    expect(registry.resolveNext("npm.test", "user")).toBeUndefined();
  });

  it("reveals lower definitions after removing overrides", () => {
    const registry = new LayeredFunctionRegistry<Definition>();
    registry.set(definition("validatePit", "global"));
    registry.set(definition("validatePit", "project"));
    registry.set(definition("validatePit", "session"));

    expect(registry.delete("session", "validatePit")).toBe(true);
    expect(registry.resolve("validatePit")?.layer).toBe("project");
    registry.clear("project");
    expect(registry.resolve("validatePit")?.layer).toBe("global");
  });

  it("rejects overrides of sealed global functions", () => {
    const registry = new LayeredFunctionRegistry<Definition>();
    registry.set({ ...definition("functions.promote", "global"), sealed: true });

    expect(() => registry.set(definition("functions.promote", "project"))).toThrow(
      'global function "functions.promote" is sealed',
    );
  });

  it("rejects namespace conflicts across layers", () => {
    const registry = new LayeredFunctionRegistry<Definition>();
    registry.set(definition("workspace", "global"));

    expect(() => registry.set(definition("workspace.read", "project"))).toThrow(
      'function namespace conflict: "workspace" and "workspace.read"',
    );
  });

  it("returns sorted effective identifiers and all definitions", () => {
    const registry = new LayeredFunctionRegistry<Definition>();
    registry.set(definition("zeta", "global", "global zeta"));
    registry.set(definition("alpha", "global"));
    registry.set(definition("zeta", "user", "user zeta"));

    expect(registry.identifiers()).toEqual(["alpha", "zeta"]);
    expect([...registry.effective()].map(([id, entry]) => [id, entry.value])).toEqual([
      ["alpha", "global"],
      ["zeta", "user zeta"],
    ]);
    expect(registry.definitions()).toHaveLength(3);
  });

  it("inspects exact layers and resolved chains", () => {
    const registry = new LayeredFunctionRegistry<Definition>();
    registry.set(definition("workspace.read", "global"));
    registry.set(definition("workspace.read", "project"));

    expect(registry.get("global", "workspace.read")?.layer).toBe("global");
    expect(registry.resolved("workspace.read")).toEqual({
      effective: expect.objectContaining({ layer: "project" }),
      chain: [
        expect.objectContaining({ layer: "project" }),
        expect.objectContaining({ layer: "global" }),
      ],
    });
    expect(registry.resolved("missing")).toBeUndefined();
    expect(registry.chain("missing")).toEqual([]);
    expect(registry.resolve("missing")).toBeUndefined();
  });
});
