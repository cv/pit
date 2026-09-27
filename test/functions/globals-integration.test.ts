import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  cleanupHarness,
  context,
  execMock,
  run,
  renderToolResult,
  setupHarness,
  tool,
  value,
} from "../support/extension-fixture.js";

beforeEach(setupHarness);
afterEach(cleanupHarness);

function define(functionId: string, code: string) {
  return tool.execute(
    "global-override",
    { code, functionId, saveOnly: true },
    undefined,
    undefined,
    context(),
  );
}

const issueFields = "number,title,state,url,labels";
const prFields =
  "number,title,state,url,headRefName,baseRefName,mergeable,reviewDecision,statusCheckRollup";
const runFields = "databaseId,status,conclusion,url,name,headSha";
const releaseFields = "tagName,name,url,isDraft,isPrerelease,publishedAt";

describe("source-backed command globals", () => {
  it.each<{ id: string; args: unknown[]; argv: string[] }>([
    { id: "git.status", args: [], argv: ["status"] },
    { id: "git.diff", args: [["--stat"]], argv: ["diff", "--stat"] },
    { id: "git.log", args: [["-2"]], argv: ["log", "-2"] },
    { id: "git.add", args: [["--", "a file"]], argv: ["add", "--", "a file"] },
    {
      id: "git.commit",
      args: [["-m", "$(not-a-shell)"]],
      argv: ["commit", "-m", "$(not-a-shell)"],
    },
    { id: "git.show", args: [["HEAD"]], argv: ["show", "HEAD"] },
    { id: "git.push", args: [], argv: ["push"] },
    { id: "git.tag", args: [["--list"]], argv: ["tag", "--list"] },
    { id: "npm.run", args: ["check", ["--fix"]], argv: ["run", "check", "--", "--fix"] },
    { id: "npm.test", args: [{ coverage: true }], argv: ["run", "coverage"] },
    { id: "npm.install", args: [["pkg"], { dev: true }], argv: ["install", "--save-dev", "pkg"] },
    { id: "npm.audit", args: [], argv: ["audit", "--json"] },
    { id: "npm.outdated", args: [], argv: ["outdated", "--json"] },
    { id: "npm.pack", args: [], argv: ["pack", "--json", "--dry-run"] },
    { id: "gh.issueList", args: [], argv: ["issue", "list", "--json", issueFields] },
    {
      id: "gh.issueView",
      args: [7],
      argv: ["issue", "view", "7", "--json", `${issueFields},body,comments`],
    },
    {
      id: "gh.issueCreate",
      args: [{ title: "hello" }],
      argv: ["issue", "create", "--title", "hello"],
    },
    {
      id: "gh.issueComment",
      args: [7, "a comment"],
      argv: ["issue", "comment", "7", "--body", "a comment"],
    },
    { id: "gh.issueClose", args: [7], argv: ["issue", "close", "7"] },
    { id: "gh.prList", args: [], argv: ["pr", "list", "--json", prFields] },
    {
      id: "gh.prView",
      args: [8],
      argv: ["pr", "view", "8", "--json", `${prFields},body,comments,reviews`],
    },
    {
      id: "gh.prCreate",
      args: [{ title: "new" }],
      argv: ["pr", "create", "--title", "new", "--body", ""],
    },
    { id: "gh.prMerge", args: [8, { method: "squash" }], argv: ["pr", "merge", "8", "--squash"] },
    { id: "gh.runList", args: [], argv: ["run", "list", "--json", runFields] },
    { id: "gh.runView", args: [9], argv: ["run", "view", "9", "--json", `${runFields},jobs`] },
    { id: "gh.releaseView", args: [], argv: ["release", "view", "--json", releaseFields] },
    {
      id: "gh.releaseCreate",
      args: ["v1", { title: "release" }],
      argv: ["release", "create", "v1", "--title", "release"],
    },
    { id: "gh.api", args: ["user"], argv: ["api", "user"] },
  ])("executes $id as argument-safe source composition", async ({ id, args, argv }) => {
    const [namespace, method] = id.split(".");
    execMock.mockResolvedValue({ stdout: id, stderr: "", code: 0 });
    const result = await value(
      `async ({ ${namespace}: { ${method} } }) => ${method}(${args.map((arg) => JSON.stringify(arg)).join(",")})`,
    );
    expect(result).toEqual({ stdout: id, stderr: "", code: 0, truncated: false });
    expect(execMock).toHaveBeenCalledExactlyOnceWith(
      namespace,
      argv,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it.each<{ name: string; source: string; program: string; argv: string[] }>([
    {
      name: "Git",
      source: 'async ({ git: { status } }) => status(["--short"], { maxBytes: 123 })',
      program: "git",
      argv: ["status", "--short"],
    },
    {
      name: "npm",
      source: "async ({ npm: { test } }) => test({ coverage: true, maxBytes: 123 })",
      program: "npm",
      argv: ["run", "coverage"],
    },
    {
      name: "GitHub",
      source: 'async ({ gh: { api } }) => api("user", [], { maxBytes: 123 })',
      program: "gh",
      argv: ["api", "user"],
    },
  ])(
    "resolves $name's process dependency through a session override",
    async ({ source, program, argv }) => {
      await define(
        "shell.execFile",
        `async function execFile({}, program: string, args: string[], options?: PitProcessOptions): Promise<PitProcessResult> {
      return { stdout: JSON.stringify({program,args,options}), stderr: "", code: 0, truncated: false };
    }`,
      );
      const result = await value(source);
      expect(JSON.parse(result.stdout)).toEqual({
        program,
        args: argv,
        options: { maxBytes: 123 },
      });
      expect(execMock).not.toHaveBeenCalled();
      const inspected = await value(
        'async ({ functions: { getSaved } }) => getSaved("git.status", "global")',
      );
      expect(inspected).toMatchObject({
        kind: "source",
        effects: [],
        resolvedDependencies: [{ name: "shell.execFile", scope: "session", available: true }],
      });
    },
  );

  it("composes next through both a command override and a primitive override", async () => {
    await define(
      "shell.execFile",
      `async function execFile({ $next }, program: string, args: string[], options?: PitProcessOptions) {
      const result = await $next(program, args, options); return {...result, stdout: result.stdout + "|shell"};
    }`,
    );
    await define(
      "git.status",
      `async function status({ $next }, args?: string[], options?: PitProcessOptions) {
      const result = await $next(args, options); return {...result, stdout: result.stdout + "|git"};
    }`,
    );
    execMock.mockResolvedValue({ stdout: "host", stderr: "", code: 0 });
    expect(await value('async ({ git: { status } }) => status(["--short"])')).toMatchObject({
      stdout: "host|shell|git",
    });
    expect(execMock).toHaveBeenCalledExactlyOnceWith(
      "git",
      ["status", "--short"],
      expect.anything(),
    );
  });

  it.each<{ name: string; source: string; error: string }>([
    {
      name: "missing required GitHub argument",
      source: "async ({ gh: { prView } }) => (prView as any)()",
      error: "gh.prView expects 1-2 argument(s)",
    },
    {
      name: "excess Git arguments",
      source: "async ({ git: { status } }) => (status as any)([], {}, 1)",
      error: "git.status expects 0-2 argument(s)",
    },
    {
      name: "invalid npm flag",
      source: 'async ({ npm: { test } }) => (test as any)({coverage:"yes"})',
      error: "options.coverage must be a boolean",
    },
    {
      name: "invalid GitHub fields",
      source: "async ({ gh: { issueList } }) => issueList({json:[]})",
      error: "options.json must contain at least one field",
    },
  ])("rejects $name before any process effect", async ({ source, error }) => {
    await expect(value(source)).rejects.toThrow(error);
    expect(execMock).not.toHaveBeenCalled();
  });

  it("retains npm warning semantics and full data when the effect is shell.execFile", async () => {
    const stdout = JSON.stringify({
      pit: { current: "1.0.0", wanted: "1.0.0", latest: "2.0.0", extra: "RETAINED_GLOBAL_FIELD" },
    });
    execMock.mockResolvedValue({ stdout, stderr: "", code: 1 });
    const result = await run("async ({ npm: { outdated } }) => outdated()");
    const collapsed = renderToolResult(result, { expanded: false, isPartial: false });
    expect(collapsed).toContain("⚠");
    expect(collapsed).toContain("npm");
    expect(collapsed).not.toContain("✗");
    const expanded = renderToolResult(result, { expanded: true, isPartial: false });
    expect(expanded).toContain("RETAINED_GLOBAL_FIELD");
    expect(result.details.value).toMatchObject({ stdout, code: 1 });
  });

  it("does not borrow global domain semantics for a same-named source override", async () => {
    await define(
      "npm.outdated",
      'async function outdated({ shell: { execFile } }, options?: PitProcessOptions) { return execFile("custom", [], options ?? {}); }',
    );
    execMock.mockResolvedValue({
      stdout: JSON.stringify({ pit: { current: "1", latest: "2" } }),
      stderr: "",
      code: 1,
    });
    const result = await run("async ({ npm: { outdated } }) => outdated()");
    const collapsed = renderToolResult(result, { expanded: false, isPartial: false });
    expect(collapsed).toContain("✗");
    expect(collapsed).toContain("Command exit 1");
    expect(collapsed).not.toContain("⚠");
  });

  it("retains primitive output bounds through a source global", async () => {
    execMock.mockResolvedValue({ stdout: "abcdefghij", stderr: "", code: 0 });
    const result = await value(
      'async ({ gh: { api } }) => api("user", [], { maxBytes: 4, truncate: "head" })',
    );
    expect(result).toMatchObject({ stdout: "abcd", code: 0, truncated: true });
  });

  it("propagates cancellation from a source global into its native process", async () => {
    const controller = new AbortController();
    let aborted = false;
    execMock.mockImplementation(
      (_program, _args, options) =>
        new Promise((resolve) => {
          options.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve({ stdout: "", stderr: "", code: 130 });
            },
            { once: true },
          );
          controller.abort();
        }),
    );
    await expect(
      run('async ({ gh: { api } }) => api("user")', context(), controller.signal),
    ).rejects.toThrow(/cancelled/i);
    expect(aborted).toBe(true);
    expect(execMock).toHaveBeenCalledOnce();
  });

  it("keeps concurrent host calls attributed to their global source callers", async () => {
    execMock.mockImplementation(async (program, argv) => ({
      stdout: `${program}:${argv[0]}`,
      stderr: "",
      code: 0,
    }));
    const result = await run(
      "async ({ git: { status }, npm: { pack } }) => Promise.all([status(), pack()])",
    );
    expect(result.details.value.map((entry: PitProcessResult) => entry.stdout)).toEqual([
      "git:status",
      "npm:pack",
    ]);
    expect(
      result.details.traces
        .filter((trace: any) => trace.capability === "shell")
        .map((trace: any) => trace.function),
    ).toEqual([
      expect.objectContaining({ name: "git.status", scope: "global" }),
      expect.objectContaining({ name: "npm.pack", scope: "global" }),
    ]);
    expect(result.details.functions ?? []).toEqual([]);
  });
});
