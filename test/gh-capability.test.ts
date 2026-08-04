import { describe, expect, it } from "vitest";
import type { CapabilityCall } from "../src/capability-presentation.js";
import { prepareGhCommand } from "../src/gh-capability.js";
import { renderResultValue } from "../src/renderers/generic.js";

const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
const result = (stdout = "", stderr = "", code = 0, truncated = false) => ({
  stdout,
  stderr,
  code,
  truncated,
});
function render(value: unknown) {
  const call: CapabilityCall = {
    capability: "gh",
    method: "issueList",
    qualifiedName: "gh.issueList",
  };
  const r = renderResultValue(value, theme, call);
  if (!r) {
    throw new Error("Expected gh renderer");
  }
  return r;
}
describe("gh capability", () => {
  it("prepares filtered issue and pull request lists with selected fields", () => {
    expect(
      prepareGhCommand("issueList", [
        {
          repo: "cv/pit",
          state: "open",
          limit: 5,
          author: "@me",
          assignee: "octocat",
          labels: ["bug", "help wanted"],
          search: "is:open",
          json: ["number", "author"],
          args: ["--app", "dependabot"],
          raise: true,
        },
      ]),
    ).toEqual({
      args: [
        "issue",
        "list",
        "--repo",
        "cv/pit",
        "--state",
        "open",
        "--limit",
        "5",
        "--author",
        "@me",
        "--assignee",
        "octocat",
        "--label",
        "bug",
        "--label",
        "help wanted",
        "--search",
        "is:open",
        "--app",
        "dependabot",
        "--json",
        "number,author",
      ],
      options: { raise: true },
    });
    expect(
      prepareGhCommand("prList", [
        {
          state: "merged",
          base: "main",
          head: "fix",
          draft: true,
          json: ["number", "isDraft"],
        },
      ]).args,
    ).toEqual([
      "pr",
      "list",
      "--state",
      "merged",
      "--base",
      "main",
      "--head",
      "fix",
      "--draft",
      "--json",
      "number,isDraft",
    ]);
  });

  it.each<{
    name: string;
    method: "issueView" | "prView" | "runView" | "releaseView";
    args: unknown[];
  }>([
    { name: "issue", method: "issueView", args: [30, { json: ["number"], args: ["--comments"] }] },
    { name: "pull request", method: "prView", args: [29, { json: ["title"] }] },
    { name: "run", method: "runView", args: [123, { json: ["status"] }] },
    { name: "release", method: "releaseView", args: ["v1", { json: ["tagName"] }] },
  ])("selects $name view fields", ({ method, args }) => {
    const command = prepareGhCommand(method, args).args;
    expect(command.at(-2)).toBe("--json");
    expect(command.at(-1)).toBe((args.at(-1) as { json: string[] }).json.join(","));
  });

  it("prepares filtered runs, releases, and api calls", () => {
    expect(
      prepareGhCommand("runList", [
        {
          limit: 2,
          branch: "main",
          commit: "abc1234",
          event: "push",
          status: "success",
          user: "@me",
          workflow: "ci.yml",
          json: ["databaseId", "headSha"],
        },
      ]).args,
    ).toEqual([
      "run",
      "list",
      "--limit",
      "2",
      "--branch",
      "main",
      "--commit",
      "abc1234",
      "--event",
      "push",
      "--status",
      "success",
      "--user",
      "@me",
      "--workflow",
      "ci.yml",
      "--json",
      "databaseId,headSha",
    ]);
    expect(
      prepareGhCommand("releaseCreate", [
        "v1",
        { title: "Release", body: "notes", args: ["--draft"] },
      ]).args,
    ).toContain("--draft");
    expect(prepareGhCommand("api", ["repos/cv/pit", ["--method", "GET"]]).args).toEqual([
      "api",
      "repos/cv/pit",
      "--method",
      "GET",
    ]);
  });

  it.each<{
    name: string;
    method: "issueCreate" | "issueComment" | "issueClose";
    args: unknown[];
    expected: string;
  }>([
    {
      name: "issue creation",
      method: "issueCreate",
      args: [{ title: "Title", args: ["--label", "bug"] }],
      expected: "--label",
    },
    {
      name: "issue comments",
      method: "issueComment",
      args: [30, "hello", { args: ["--edit-last"] }],
      expected: "--edit-last",
    },
    {
      name: "issue closure",
      method: "issueClose",
      args: [30, { args: ["--reason", "completed"] }],
      expected: "--reason",
    },
  ])("passes argument-safe extras for $name", ({ method, args, expected }) => {
    expect(prepareGhCommand(method, args).args).toContain(expected);
  });

  it("validates identifiers and typed options", () => {
    expect(() => prepareGhCommand("issueView", ["bad"] as any)).toThrow(
      "number must be an integer",
    );
    expect(() => prepareGhCommand("issueCreate", [{ body: "missing" }] as any)).toThrow(
      "input.title must be a string",
    );
    expect(() => prepareGhCommand("issueList", [{ args: "bad" }] as any)).toThrow(
      "options.args must be an array of strings",
    );
    expect(() => prepareGhCommand("issueList", [{ json: [] }] as any)).toThrow(
      "options.json must contain at least one field",
    );
    expect(() => prepareGhCommand("issueList", [{ labels: "bug" }] as any)).toThrow(
      "options.labels must be an array of strings",
    );
    expect(() => prepareGhCommand("prList", [{ draft: "yes" }] as any)).toThrow(
      "options.draft must be a boolean",
    );
    expect(() => (prepareGhCommand as any)("unknown", [])).toThrow("Unknown gh method");
  });
});
describe("gh renderer", () => {
  it("renders structured lists and objects", () => {
    const list = render(
      result(
        JSON.stringify([{ number: 30, title: "Epic", state: "OPEN", url: "https://example" }]),
      ),
    );
    expect(list.summary).toBe("1 result");
    expect(list.lines.join("\n")).toContain("#30 Epic [OPEN]");
    const object = render(
      result(
        JSON.stringify({
          number: 29,
          title: "PR",
          state: "MERGED",
          url: "https://example",
          body: "text",
        }),
      ),
    );
    expect(object.summary).toBe("1 result");
    expect(object.lines.join("\n")).toContain("body: text");
  });
  it("renders text, errors, empty output, and malformed values", () => {
    expect(render(result("created https://example")).summary).toBe("exit 0");
    expect(render(result("", "failed", 1, true)).summary).toBe("exit 1, truncated");
    expect(render(result()).lines).toContain("(no output)");
    const call: CapabilityCall = {
      capability: "gh",
      method: "issueList",
      qualifiedName: "gh.issueList",
    };
    expect(renderResultValue(null, theme, call)).toBeUndefined();
  });

  describe("gh fallback branches", () => {
    it("covers omitted repository, state, limits, bodies, tags, and api args", () => {
      expect(prepareGhCommand("issueList", []).args).toContain("--json");
      expect(prepareGhCommand("issueCreate", [{ title: "Only" }]).args).not.toContain("--body");
      expect(prepareGhCommand("runList", []).args).not.toContain("--limit");
      expect(prepareGhCommand("releaseView", []).args).toEqual([
        "release",
        "view",
        "--json",
        "tagName,name,url,isDraft,isPrerelease,publishedAt",
      ]);
      expect(prepareGhCommand("releaseView", [undefined, { repo: "cv/pit" }]).args).toContain(
        "cv/pit",
      );
      expect(prepareGhCommand("releaseCreate", ["v1", { title: "Release" }]).args).not.toContain(
        "--notes",
      );
      expect(prepareGhCommand("api", ["user"]).args).toEqual(["api", "user"]);
      expect(prepareGhCommand("api", ["user", [], { repo: "ignored" }]).args).toEqual([
        "api",
        "user",
      ]);
    });

    it("covers argument validation helpers", () => {
      expect(() => prepareGhCommand("issueList", ["bad"] as any)).toThrow(
        "options must be an object",
      );
      expect(() => prepareGhCommand("issueCreate", [{ title: 1 }] as any)).toThrow(
        "input.title must be a string",
      );
      expect(() => prepareGhCommand("api", ["user", "bad"] as any)).toThrow(
        "args must be an array of strings",
      );
      expect(() => prepareGhCommand("issueList", [{ limit: "bad" }] as any)).toThrow(
        "options.limit must be an integer",
      );
    });

    it("covers renderer primitive JSON, primitive lists, stderr, and malformed process values", () => {
      expect(render(result(JSON.stringify(["one", 2]))).summary).toBe("2 results");
      expect(
        render(result(JSON.stringify({ name: "run", jobs: [{ name: "test" }] }))).lines.join("\n"),
      ).toContain("jobs:");
      expect(render(result("plain", "warning", 1, true)).summary).toBe("exit 1, truncated");
      const call: CapabilityCall = {
        capability: "gh",
        method: "issueList",
        qualifiedName: "gh.issueList",
      };
      expect(renderResultValue({ stdout: "x" }, theme, call)).toBeUndefined();
    });
  });
});
