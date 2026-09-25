import { transform } from "esbuild";
import { describe, expect, it, vi } from "vitest";

import { createLayeredFunctionRegistry } from "../../src/functions/definitions.js";
import {
  resolveFunctionGraph,
  sourceFunctionDefinition,
} from "../../src/functions/resolved-graph.js";
import { unifiedRuntimeProgram } from "../../src/functions/unified-runtime.js";

async function execute(
  source: string,
  definitions: Parameters<typeof createLayeredFunctionRegistry>[0],
  capabilities: object,
  input?: unknown,
) {
  const graph = resolveFunctionGraph(source, createLayeredFunctionRegistry(definitions));
  const generated = unifiedRuntimeProgram(source, graph);
  const compiled = await transform(`(${generated})`, { loader: "ts", target: "es2022" });
  // oxlint-disable-next-line no-eval -- execute generated sandbox source in the unit test.
  const main = (0, eval)(compiled.code) as (
    capabilities: (context: unknown) => object,
    input: unknown,
    runSaved: (
      name: string,
      layer: string,
      parent: unknown,
      callback: (context: unknown) => Promise<unknown>,
    ) => Promise<unknown>,
  ) => Promise<unknown>;
  return main(
    () => capabilities,
    input,
    async (name, layer, _parent, callback) => callback({ name, layer }),
  );
}

describe("unified function runtime", () => {
  it("injects native and source functions through one dependency object", async () => {
    const read = vi.fn(async (file: string) => ({ content: `contents:${file}` }));
    const savedFunctionRun = vi.fn(async () => null);
    const source = `async ({ inspectFile }, input: { file: string }) => inspectFile(input)`;
    const definitions = [
      sourceFunctionDefinition(
        "inspectFile",
        "project",
        `async function inspectFile(
          { workspace: { read } },
          input: { file: string },
        ) {
          return read(input.file);
        }`,
      ),
    ];

    await expect(
      execute(
        source,
        definitions,
        { workspace: { read }, __pit: { savedFunctionRun } },
        { file: "README.md" },
      ),
    ).resolves.toEqual({ content: "contents:README.md" });
    expect(read).toHaveBeenCalledWith("README.md");
    expect(savedFunctionRun).toHaveBeenCalledWith("inspectFile");
  });

  it("provides frozen null-prototype direct dependency objects", async () => {
    const source = "async ({ inspect }) => inspect()";
    const definitions = [
      sourceFunctionDefinition(
        "inspect",
        "session",
        `async function inspect({ workspace: { read } }) {
          return {
            rootFrozen: Object.isFrozen(arguments[0]),
            namespaceFrozen: Object.isFrozen(arguments[0].workspace),
            rootPrototype: Object.getPrototypeOf(arguments[0]),
            namespacePrototype: Object.getPrototypeOf(arguments[0].workspace),
            readType: typeof read,
          };
        }`,
      ),
    ];

    await expect(
      execute(source, definitions, {
        workspace: { read: async () => null },
        __pit: { savedFunctionRun: async () => null },
      }),
    ).resolves.toEqual({
      rootFrozen: true,
      namespaceFrozen: true,
      rootPrototype: null,
      namespacePrototype: null,
      readType: "function",
    });
  });

  it("dispatches next to the lower definition", async () => {
    const status = vi.fn(async () => "clean");
    const source = "async ({ git: { status } }) => status()";
    const definitions = [
      sourceFunctionDefinition(
        "git.status",
        "project",
        `async function status({ $next }) {
          return "project:" + await $next();
        }`,
      ),
    ];

    await expect(
      execute(source, definitions, {
        git: { status },
        __pit: { savedFunctionRun: async () => null },
      }),
    ).resolves.toBe("project:clean");
  });
});
