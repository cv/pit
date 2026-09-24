import { execFileSync } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { skipWithoutJq } from "../helpers/jq.js";
import { loadWorkflowFunction, processResult } from "../helpers/workflow-function.js";

const OUTPUT_BUDGET = 45_000;
const rawView = {
  title: "Review fixture",
  url: "https://example.invalid/pr/1",
  state: "OPEN",
  reviewDecision: "",
  body: "release notes ".repeat(10000),
  comments: Array.from({ length: 10 }, (_, index) => ({
    author: { login: `user${index}` },
    body: index === 9 ? "long ".repeat(800) : `comment ${index}`,
  })),
  reviews: [{ author: { login: "reviewer" }, state: "APPROVED", body: "approved" }] as Array<{
    author: { login: string };
    state?: string;
    body: string;
  }>,
  statusCheckRollup: [] as Array<Record<string, string>>,
};
const defaultCommits = [{ sha: "abc1234", subject: "commit", messageTruncated: false }];

function discussion(count: number, body: string, state?: string) {
  return Array.from({ length: count }, (_, index) => ({
    author: { login: `author${index}` },
    body,
    ...(state ? { state } : {}),
  }));
}

function checkRun(index: number) {
  return {
    __typename: "CheckRun",
    name: `check-${index}`,
    workflowName: "CI",
    status: "COMPLETED",
    conclusion: index % 10 === 0 ? "FAILURE" : "SUCCESS",
    detailsUrl: `https://example.invalid/checks/${index}`,
    startedAt: "2026-01-01T00:00:00Z",
  };
}

function serializedBytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value, null, 2));
}

function dependencies(view = rawView, commits: unknown[] = defaultCommits) {
  const prView = vi.fn(async (_number: number, options: { args: string[]; maxBytes: number }) => {
    const query = options.args[options.args.indexOf("--jq") + 1];
    if (!query) throw new Error("No pre-transport projection");
    const stdout = execFileSync("jq", ["-c", query], {
      input: JSON.stringify(view),
      encoding: "utf8",
    });
    // Simulate the transport cap after projection, as the real capability does.
    const bytes = Buffer.from(stdout);
    return processResult({
      stdout: bytes.subarray(0, options.maxBytes).toString("utf8"),
      truncated: bytes.length > options.maxBytes,
    });
  });
  const api = vi.fn(async (endpoint: string, _args: string[] = []) =>
    processResult({
      stdout: JSON.stringify(
        endpoint.endsWith("/commits")
          ? commits
          : endpoint.endsWith("/files")
            ? [
                {
                  filename: "src/file.ts",
                  status: "modified",
                  additions: 1,
                  deletions: 0,
                  changes: 1,
                },
              ]
            : { headSha: "abc1234", commitCount: 3, fileCount: 2 },
      ),
    }),
  );
  return { prView, api };
}

describe.skipIf(skipWithoutJq)("bounded PR inspection", () => {
  it("projects a large body before the process cap and reports omitted discussion and pages", async () => {
    const inspect = await loadWorkflowFunction("inspectGitHubPullRequest");
    const gh = dependencies();
    const result = await inspect({ gh }, { number: 1 });
    expect(result).toMatchObject({
      number: 1,
      title: "Review fixture",
      body: rawView.body.slice(0, 8000),
      omissions: {
        bodyCharacters: rawView.body.length - 8000,
        comments: 2,
        reviews: 0,
        checks: 0,
        commits: 2,
        files: 1,
      },
    });
    expect(result.comments).toHaveLength(8);
    expect(result.comments).toEqual(
      expect.arrayContaining([expect.objectContaining({ author: "user9", bodyTruncated: true })]),
    );
    expect(result.reviews).toEqual([
      expect.objectContaining({
        author: "reviewer",
        state: "APPROVED",
        body: "approved",
        bodyTruncated: false,
      }),
    ]);
    expect(gh.prView).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        repo: "cv/pit",
        json: expect.arrayContaining(["body", "comments", "reviews", "statusCheckRollup"]),
      }),
    );
  });

  it("fits a long discussion into the output budget with explicit shortening", async () => {
    const inspect = await loadWorkflowFunction("inspectGitHubPullRequest");
    const gh = dependencies(
      {
        ...rawView,
        body: "b".repeat(20000),
        comments: discussion(12, "c".repeat(5000)),
        reviews: discussion(10, "r".repeat(5000), "COMMENTED"),
        statusCheckRollup: Array.from({ length: 60 }, (_, index) => checkRun(index)),
      },
      Array.from({ length: 30 }, (_, index) => ({
        sha: `abc${index}`,
        subject: "s".repeat(200),
        messageTruncated: true,
      })),
    );
    const result = await inspect({ gh }, { number: 1 });
    expect(serializedBytes(result)).toBeLessThanOrEqual(OUTPUT_BUDGET);
    expect(result.omissions).toMatchObject({ comments: 4, reviews: 2, checks: 20 });
    const previews = [...(result.comments as unknown[]), ...(result.reviews as unknown[])];
    expect(previews).toHaveLength(16);
    expect(previews).toEqual(
      Array.from({ length: 16 }, () => expect.objectContaining({ bodyTruncated: true })),
    );
    const checks = result.checks as Array<Record<string, unknown>>;
    expect(
      checks.filter((check) => check.conclusion === "FAILURE").map((check) => check.name),
    ).toEqual(
      expect.arrayContaining([
        "check-0",
        "check-10",
        "check-20",
        "check-30",
        "check-40",
        "check-50",
      ]),
    );
    expect(checks).toContainEqual({
      name: "check-0",
      workflow: "CI",
      status: "COMPLETED",
      conclusion: "FAILURE",
      url: "https://example.invalid/checks/0",
    });
  });

  it("retries multibyte previews instead of failing on transport truncation", async () => {
    const inspect = await loadWorkflowFunction("inspectGitHubPullRequest");
    const emoji = "\u{1F642}";
    const gh = dependencies({
      ...rawView,
      body: emoji.repeat(20000),
      comments: discussion(8, emoji.repeat(5000)),
      reviews: [],
    });
    const result = await inspect({ gh }, { number: 1 });
    expect(serializedBytes(result)).toBeLessThanOrEqual(OUTPUT_BUDGET);
    expect(result.body).toMatch(/^(?:\u{1F642})+$/u);
    expect(result.omissions).toMatchObject({ bodyCharacters: expect.any(Number) });
    expect((result.omissions as { bodyCharacters: number }).bodyCharacters).toBeGreaterThan(0);
    expect(result.comments).toEqual(
      Array.from({ length: 8 }, () => expect.objectContaining({ bodyTruncated: true })),
    );
  });

  it("projects commit subjects and flags longer messages", async () => {
    const inspect = await loadWorkflowFunction("inspectGitHubPullRequest");
    const gh = dependencies();
    await inspect({ gh }, { number: 1 });
    const query = gh.api.mock.calls.find(([endpoint]) => endpoint.endsWith("/commits"))?.[1]?.[1];
    if (!query) throw new Error("No commit projection");
    const commit = (sha: string, message: string) => ({
      sha,
      commit: { message, author: { name: "Author" } },
    });
    const projected = JSON.parse(
      execFileSync("jq", ["-c", query], {
        input: JSON.stringify([
          commit("1111111aaaa", "Subject only\n"),
          commit("2222222bbbb", "Subject\n\nBody text"),
          commit("3333333cccc", "x".repeat(250)),
        ]),
        encoding: "utf8",
      }),
    );
    expect(projected).toEqual([
      { sha: "1111111", subject: "Subject only", messageTruncated: false, author: "Author" },
      { sha: "2222222", subject: "Subject", messageTruncated: true, author: "Author" },
      { sha: "3333333", subject: "x".repeat(200), messageTruncated: true, author: "Author" },
    ]);
  });

  it.each(["view", "metadata", "commits", "files"])(
    "rejects truncated %s JSON before parsing it",
    async (stage) => {
      const inspect = await loadWorkflowFunction("inspectGitHubPullRequest");
      const gh = dependencies();
      const broken = processResult({ stdout: "[partial", truncated: true });
      if (stage === "view") gh.prView.mockResolvedValue(broken);
      else {
        const original = gh.api.getMockImplementation();
        if (!original) throw new Error("Missing API fixture");
        gh.api.mockImplementation(async (endpoint) =>
          (
            stage === "metadata"
              ? !endpoint.endsWith("/commits") && !endpoint.endsWith("/files")
              : endpoint.endsWith(`/${stage}`)
          )
            ? broken
            : original(endpoint),
        );
      }
      await expect(inspect({ gh }, { number: 1 })).rejects.toThrow(`${stage} JSON was truncated`);
    },
  );

  it("distinguishes malformed complete JSON from truncation", async () => {
    const inspect = await loadWorkflowFunction("inspectGitHubPullRequest");
    const gh = dependencies();
    gh.prView.mockResolvedValue(processResult({ stdout: "not json" }));
    await expect(inspect({ gh }, { number: 1 })).rejects.toThrow("view returned invalid JSON");
  });

  it("rejects a summary that cannot fit even without text previews", async () => {
    const inspect = await loadWorkflowFunction("inspectGitHubPullRequest");
    const gh = dependencies();
    gh.api.mockImplementation(async (endpoint) =>
      processResult({
        stdout: JSON.stringify(
          endpoint.endsWith("/commits") || endpoint.endsWith("/files")
            ? [{ data: "x".repeat(24000) }]
            : {},
        ),
      }),
    );
    await expect(inspect({ gh }, { number: 1 })).rejects.toThrow(
      "review summary exceeds 45000 bytes even without text previews",
    );
  });

  it.each([{ number: 0 }, { number: 1, repo: "invalid/repo/path" }])(
    "validates identifiers before requests: %j",
    async (input) => {
      const inspect = await loadWorkflowFunction("inspectGitHubPullRequest");
      const gh = dependencies();
      await expect(inspect({ gh }, input)).rejects.toThrow();
      expect(gh.prView).not.toHaveBeenCalled();
      expect(gh.api).not.toHaveBeenCalled();
    },
  );
});
