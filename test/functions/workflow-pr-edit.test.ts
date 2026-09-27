import { describe, expect, it, vi } from "vitest";

import { loadWorkflowFunction, processResult } from "../helpers/workflow-function.js";

const original = [
  "## Summary",
  "Old summary.",
  "",
  "## Validation",
  "- [x] Gates",
  "- [ ] PR checks",
  "- [ ] Live smoke",
].join("\n");

// GitHub echoes the stored body's length; `stored` simulates a body GitHub changed.
function github(body = original, stored?: number) {
  const prView = vi
    .fn()
    .mockResolvedValue(
      processResult({ stdout: JSON.stringify({ body, url: "https://github.com/cv/pit/pull/7" }) }),
    );
  const api = vi.fn(async (_endpoint: string, args: string[]) => {
    const sent = (args[args.indexOf("-f") + 1] ?? "").slice("body=".length);
    return processResult({ stdout: `${stored ?? [...sent].length}\n` });
  });
  return { prView, api, dependencies: { gh: { prView, api } } };
}

describe("pr.editBody", () => {
  it("applies replacements, checklist ticks, and an appended section in one write", async () => {
    const editBody = await loadWorkflowFunction("pr.editBody");
    const { prView, api, dependencies } = github();
    const result = await editBody(dependencies, {
      number: 7,
      repo: "cv/pit",
      replace: [["Old summary.", "New summary."]],
      check: ["PR checks"],
      append: "### Follow-up\nDone.",
    });
    expect(prView).toHaveBeenCalledWith(7, expect.objectContaining({ repo: "cv/pit" }));
    expect(api).toHaveBeenCalledOnce();
    const [endpoint, args] = api.mock.calls[0] ?? ["", []];
    expect(endpoint).toBe("repos/cv/pit/pulls/7");
    expect(args.slice(0, 2)).toEqual(["--method", "PATCH"]);
    const expected = [
      "## Summary",
      "New summary.",
      "",
      "## Validation",
      "- [x] Gates",
      "- [x] PR checks",
      "- [ ] Live smoke",
      "",
      "### Follow-up",
      "Done.",
      "",
    ].join("\n");
    expect(args[args.indexOf("-f") + 1]).toBe(`body=${expected}`);
    expect(result).toMatchObject({
      written: true,
      changed: true,
      changedLines: ["New summary.", "- [x] PR checks", "### Follow-up", "Done."],
      changedLinesOmitted: 0,
    });
  });

  it("targets the current repository when repo is omitted", async () => {
    const editBody = await loadWorkflowFunction("pr.editBody");
    const { prView, api, dependencies } = github();
    await editBody(dependencies, { number: 7, check: ["Live smoke"] });
    expect(prView.mock.calls[0]?.[1]).not.toHaveProperty("repo");
    expect(api.mock.calls[0]?.[0]).toBe("repos/{owner}/{repo}/pulls/7");
  });

  it.each<{ name: string; body?: string; input: Record<string, unknown>; error: string }>([
    {
      name: "missing replacement text",
      input: { replace: [["Absent.", "x"]] },
      error: "Replacement text not found: Absent.",
    },
    {
      name: "ambiguous replacement text",
      input: { replace: [["- [", "* ["]] },
      error: "Replacement text occurs more than once: - [",
    },
    {
      name: "an item that is already checked",
      input: { check: ["Gates"] },
      error: "Unchecked item not found: - [ ] Gates",
    },
    {
      name: "a stale expectation after one that matched",
      input: { replace: [["Old summary.", "New summary."]], check: ["Deploy"] },
      error: "Unchecked item not found: - [ ] Deploy",
    },
    {
      name: "a body over GitHub's limit",
      body: "x".repeat(60_000),
      input: { append: "y".repeat(10_000) },
      error: "Edited body has 70003 characters; GitHub allows 65,536",
    },
  ])("rejects $name without writing", async ({ body, input, error }) => {
    const editBody = await loadWorkflowFunction("pr.editBody");
    const { api, dependencies } = github(body);
    await expect(editBody(dependencies, { number: 7, ...input })).rejects.toThrow(error);
    expect(api).not.toHaveBeenCalled();
  });

  it.each<{ name: string; input: Record<string, unknown>; error: string }>([
    {
      name: "repository without an owner",
      input: { repo: "pit", check: ["x"] },
      error: "owner/name",
    },
    { name: "no operation", input: {}, error: "Provide replace, check, or append" },
    { name: "empty replacement source", input: { replace: [["", "x"]] }, error: "non-empty from" },
    { name: "multiline checklist item", input: { check: ["a\nb"] }, error: "single-line" },
    { name: "blank appended section", input: { append: "  " }, error: "append must contain" },
  ])("rejects $name before reading the pull request", async ({ input, error }) => {
    const editBody = await loadWorkflowFunction("pr.editBody");
    const { prView, api, dependencies } = github();
    await expect(editBody(dependencies, { number: 7, ...input })).rejects.toThrow(error);
    expect(prView).not.toHaveBeenCalled();
    expect(api).not.toHaveBeenCalled();
  });

  it.each<{ name: string; input: Record<string, unknown>; changed: boolean }>([
    { name: "a dry run", input: { check: ["PR checks"], dryRun: true }, changed: true },
    {
      name: "an unchanged body",
      input: { replace: [["Old summary.", "Old summary."]] },
      changed: false,
    },
  ])("does not write for $name", async ({ input, changed }) => {
    const editBody = await loadWorkflowFunction("pr.editBody");
    const { api, dependencies } = github();
    const result = await editBody(dependencies, { number: 7, ...input });
    expect(api).not.toHaveBeenCalled();
    expect(result).toMatchObject({ written: false, changed });
  });

  it("fails when GitHub stores a different body than it was sent", async () => {
    const editBody = await loadWorkflowFunction("pr.editBody");
    const { dependencies } = github(original, 3);
    await expect(editBody(dependencies, { number: 7, check: ["PR checks"] })).rejects.toThrow(
      "GitHub stored 3 characters",
    );
  });
});
