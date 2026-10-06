import { describe, expect, it } from "vitest";

import { createLayeredFunctionRegistry } from "../../src/functions/definitions.js";
import { resolveFunctionGraph } from "../../src/functions/resolved-graph.js";
import { unifiedRuntimeProgram } from "../../src/functions/unified-runtime.js";
import { transpileTypeScriptExpression } from "../../src/sandbox/transpile.js";
import { sourceFunctionDefinition } from "../support/function-definitions.js";

async function execute(
  source: string,
  definitions: Parameters<typeof createLayeredFunctionRegistry>[0],
  dependencies: object,
  input?: unknown,
) {
  const graph = resolveFunctionGraph(source, createLayeredFunctionRegistry(definitions));
  const generated = unifiedRuntimeProgram(source, graph);
  const compiled = transpileTypeScriptExpression(generated);
  // oxlint-disable-next-line no-eval -- execute generated sandbox source in the unit test.
  const main = (0, eval)(compiled) as (
    dependencies: (context: unknown) => object,
    input: unknown,
    runSaved: (
      name: string,
      layer: string,
      parent: unknown,
      callback: (context: unknown) => Promise<unknown>,
    ) => Promise<unknown>,
  ) => Promise<unknown>;
  return main(
    () => dependencies,
    input,
    async (name, layer, _parent, callback) => callback({ name, layer }),
  );
}

describe("unified function runtime", () => {
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
});
