import { describe, expect, it } from "vitest";
import type { CapabilityCall } from "../src/capability-presentation.js";
import { prepareGhCommand } from "../src/gh-capability.js";
import { renderResultValue } from "../src/result-renderers.js";

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
  it("prepares issue and pull request commands", () => {
    expect(
      prepareGhCommand("issueList", [{ repo: "cv/pit", state: "open", limit: 5, raise: true }]),
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
        "--json",
        "number,title,state,url,labels",
      ],
      options: { raise: true },
    });
    expect(prepareGhCommand("issueView", [30, { repo: "cv/pit" }]).args[0]).toBe("issue");
    expect(
      prepareGhCommand("issueCreate", [{ title: "Title", body: "Body", repo: "cv/pit" }]).args,
    ).toContain("create");
    expect(prepareGhCommand("issueComment", [30, "hello", { repo: "cv/pit" }]).args).toContain(
      "comment",
    );
    expect(prepareGhCommand("issueClose", [30]).args).toEqual(["issue", "close", "30"]);
    expect(prepareGhCommand("prList", [{}]).args).toContain("--json");
    expect(prepareGhCommand("prView", [29]).args).toContain("view");
  });
  it("prepares runs, releases, and api calls", () => {
    expect(prepareGhCommand("runList", [{ limit: 2 }]).args).toContain("2");
    expect(prepareGhCommand("runView", [123]).args).toContain("123");
    expect(prepareGhCommand("releaseView", ["v0.7.0"]).args).toContain("v0.7.0");
    expect(
      prepareGhCommand("releaseCreate", ["v1", { title: "Release", body: "notes" }]).args,
    ).toContain("--notes");
    expect(prepareGhCommand("api", ["repos/cv/pit", ["--method", "GET"]]).args).toEqual([
      "api",
      "repos/cv/pit",
      "--method",
      "GET",
    ]);
  });
  it("validates identifiers and options", () => {
    expect(() => prepareGhCommand("issueView", ["bad"] as any)).toThrow(
      "number must be an integer",
    );
    expect(() => prepareGhCommand("issueCreate", [{ body: "missing" }] as any)).toThrow(
      "input.title must be a string",
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
