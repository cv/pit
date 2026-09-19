import { describe, expect, it, vi } from "vitest";

import { loadWorkflowFunction, processResult } from "../helpers/workflow-function.js";

describe("injected jq adapter", () => {
  it("passes filter, filename, and bindings as separate arguments and parses JSON values", async () => {
    const jq = await loadWorkflowFunction("jq");
    const execFile = vi
      .fn()
      .mockResolvedValue(processResult({ stdout: '{"answer":42}\nfalse\nnull\n"line\\nbreak"\n' }));
    const filter = ". + $value";
    const variables = {
      value: 'quotes " and $(not a shell)',
      count: 2,
      enabled: false,
      missing: null,
    };
    expect(
      await jq(
        { shell: { execFile } },
        { file: "- tricky\nfile.jsonl", filter, variables, rawInput: true, nullInput: true },
      ),
    ).toEqual({ values: [{ answer: 42 }, false, null, "line\nbreak"] });
    expect(execFile).toHaveBeenCalledExactlyOnceWith(
      "jq",
      [
        "--compact-output",
        "--monochrome-output",
        "--raw-input",
        "--null-input",
        "--argjson",
        "value",
        JSON.stringify(variables.value),
        "--argjson",
        "count",
        "2",
        "--argjson",
        "enabled",
        "false",
        "--argjson",
        "missing",
        "null",
        "--",
        filter,
        "./- tricky\nfile.jsonl",
      ],
      expect.objectContaining({ raise: false, timeoutMs: 30000, maxBytes: 50000, maxLines: 2000 }),
    );
  });

  it.each<{ name: string; input: Record<string, unknown>; error: string }>([
    { name: "empty file", input: { file: "" }, error: "non-empty" },
    { name: "NUL in path", input: { file: "a\0b" }, error: "non-empty" },
    { name: "empty filter", input: { filter: " " }, error: "non-empty" },
    {
      name: "invalid variable name",
      input: { variables: { "bad-name": 1 } },
      error: "variable name",
    },
    { name: "non-finite binding", input: { variables: { count: Number.NaN } }, error: "finite" },
  ])("rejects $name before starting a process", async ({ input, error }) => {
    const jq = await loadWorkflowFunction("jq");
    const execFile = vi.fn();
    await expect(
      jq({ shell: { execFile } }, { file: "file.json", filter: ".", ...input }),
    ).rejects.toThrow(error);
    expect(execFile).not.toHaveBeenCalled();
  });

  it.each<{ name: string; result: ReturnType<typeof processResult>; error: string }>([
    {
      name: "process failure",
      result: processResult({ code: 3, stderr: "invalid query" }),
      error: "invalid query",
    },
    {
      name: "truncated valid JSON",
      result: processResult({ stdout: "{}\n", truncated: true }),
      error: "truncated",
    },
    { name: "malformed output", result: processResult({ stdout: "{" }), error: "invalid JSON" },
  ])("rejects $name instead of returning partial data", async ({ result, error }) => {
    const jq = await loadWorkflowFunction("jq");
    const execFile = vi.fn().mockResolvedValue(result);
    await expect(jq({ shell: { execFile } }, { file: "/file.json", filter: "." })).rejects.toThrow(
      error,
    );
  });

  it("accepts an empty jq result stream", async () => {
    const jq = await loadWorkflowFunction("jq");
    expect(
      await jq(
        { shell: { execFile: async () => processResult() } },
        { file: "-", filter: "empty" },
      ),
    ).toEqual({ values: [] });
  });
});
