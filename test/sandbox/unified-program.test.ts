import { describe, expect, it, vi } from "vitest";

import { compileSandboxSource } from "../../src/sandbox/program.js";

async function compiledProgram(source: string, projectFunctions: ReadonlyMap<string, string>) {
  const compiled = await compileSandboxSource(source, { projectFunctions });
  // oxlint-disable-next-line no-eval -- execute generated sandbox source in the unit test.
  return (0, eval)(compiled) as (
    capabilities: (context: unknown) => object,
    input: unknown,
    runSaved: (
      name: string,
      layer: string,
      parent: unknown,
      callback: (context: unknown) => Promise<unknown>,
    ) => Promise<unknown>,
  ) => Promise<unknown>;
}

describe("compileSandboxSource", () => {
  it("compiles typed explicit custom and native dependencies", async () => {
    const source = `async ({ inspect }, input: { file: string }) => inspect(input)`;
    const inspect = `async function inspect(
      { workspace: { read: readFile } },
      input: { file: string },
    ) {
      const result = await readFile(input.file, { format: "raw" });
      return result.content;
    }`;
    const main = await compiledProgram(source, new Map([["inspect", inspect]]));
    const read = vi.fn(async (file: string) => ({ content: `read:${file}` }));

    await expect(
      main(
        () => ({ workspace: { read }, __pit: { savedFunctionRun: async () => null } }),
        { file: "README.md" },
        async (name, layer, _parent, callback) => callback({ name, layer }),
      ),
    ).resolves.toBe("read:README.md");
    expect(read).toHaveBeenCalledWith("README.md", { format: "raw" });
  });

  it.each<{ name: string; source: string; namespace: string }>([
    { name: "context", source: "async ({ context }) => context.get()", namespace: "context" },
    {
      name: "workspace alias",
      source: 'async ({ workspace: ws }) => ws.stat("README.md")',
      namespace: "workspace",
    },
    {
      name: "function inspection",
      source: "async ({ functions }) => functions.listAll({ limit: 10 })",
      namespace: "functions",
    },
    { name: "commands", source: "async ({ commands }) => commands.list()", namespace: "commands" },
  ])("explains namespace capture before compilation: $name", async ({ source, namespace }) => {
    await expect(compileSandboxSource(source, {})).rejects.toThrow(
      `cannot inject namespace "${namespace}" as a function`,
    );
  });

  it("lets a caller recover by injecting the individual function", async () => {
    await expect(compileSandboxSource("async ({ context }) => context.get()", {})).rejects.toThrow(
      "{ context: { get } }",
    );
    const main = await compiledProgram("async ({ context: { get } }) => get()", new Map());
    const get = vi.fn(async () => ({ cwd: "/project" }));
    await expect(
      main(
        () => ({ context: { get } }),
        undefined,
        async (name, layer, _parent, callback) => callback({ name, layer }),
      ),
    ).resolves.toEqual({ cwd: "/project" });
    expect(get).toHaveBeenCalledExactlyOnceWith();
  });

  it("rejects missing explicit functions before compilation", async () => {
    await expect(compileSandboxSource("async ({ missing }) => missing()", {})).rejects.toThrow(
      /Property 'missing' does not exist|unavailable function "missing"/,
    );
  });
});
