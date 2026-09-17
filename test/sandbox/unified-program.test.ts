import { describe, expect, it, vi } from "vitest";

import { compileUnifiedSandboxSource } from "../../src/sandbox/program.js";

async function compiledProgram(source: string, projectFunctions: ReadonlyMap<string, string>) {
  const compiled = await compileUnifiedSandboxSource(source, { projectFunctions });
  // oxlint-disable-next-line no-eval -- execute generated sandbox source in the unit test.
  return (0, eval)(compiled) as (
    capabilities: object,
    input: unknown,
    runSaved: (name: string, layer: string, callback: () => Promise<unknown>) => Promise<unknown>,
  ) => Promise<unknown>;
}

describe("compileUnifiedSandboxSource", () => {
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
        { workspace: { read }, __pit: { savedFunctionRun: async () => null } },
        { file: "README.md" },
        async (_name, _layer, callback) => callback(),
      ),
    ).resolves.toBe("read:README.md");
    expect(read).toHaveBeenCalledWith("README.md", { format: "raw" });
  });

  it("rejects missing explicit functions before compilation", async () => {
    await expect(
      compileUnifiedSandboxSource("async ({ missing }) => missing()", {}),
    ).rejects.toThrow(/Property 'missing' does not exist|unavailable function "missing"/);
  });
});
