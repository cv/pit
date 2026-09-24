import { describe, expect, it } from "vitest";

import { loadWorkflowFunction } from "../helpers/workflow-function.js";

// Records a call to any injected dependency, however deeply a function destructures it.
function recordingDependencies(calls: string[]) {
  const dependency = (path: string): unknown =>
    new Proxy(() => undefined, {
      get: (_target, key) => dependency(path ? `${path}.${String(key)}` : String(key)),
      apply: () => {
        calls.push(path);
        return Promise.reject(new Error(`unexpected call to ${path}`));
      },
    });
  return dependency("") as Record<string, unknown>;
}

const repo = "cv/pit";
const sha = "abcdef0";

describe("workflow numeric inputs", () => {
  it.each<{ name: string; fn: string; input: Record<string, unknown>; error: string }>([
    {
      name: "analyzePitSession examples above 30",
      fn: "analyzePitSession",
      input: { file: "session.jsonl", examples: 31 },
      error: "examples must be an integer between 1 and 30",
    },
    {
      name: "analyzePitSessions limit of 0",
      fn: "analyzePitSessions",
      input: { limit: 0 },
      error: "limit must be an integer between 1 and 20",
    },
    {
      name: "auditPitCodeQuality limit above 100",
      fn: "auditPitCodeQuality",
      input: { limit: 101 },
      error: "limit must be an integer between 1 and 100",
    },
    {
      name: "findGitHubRunForCommit limit above 100",
      fn: "findGitHubRunForCommit",
      input: { repo, sha, limit: 101 },
      error: "limit must be an integer between 1 and 100",
    },
    {
      name: "inspectPitCoverageGaps limit above 500",
      fn: "inspectPitCoverageGaps",
      input: { limit: 501 },
      error: "limit must be an integer between 1 and 500",
    },
    {
      name: "reviewPitChanges diffLines below 20",
      fn: "reviewPitChanges",
      input: { diffLines: 19 },
      error: "diffLines must be an integer between 20 and 800",
    },
    {
      name: "reviewPitChanges diffBytes above 20000",
      fn: "reviewPitChanges",
      input: { diffBytes: 20_001 },
      error: "diffBytes must be an integer between 1000 and 20000",
    },
    {
      name: "reviewPitChanges fractional commits",
      fn: "reviewPitChanges",
      input: { commits: 2.5 },
      error: "commits must be an integer between 1 and 20",
    },
    {
      name: "waitForGitHubRun intervalMs below 1000",
      fn: "waitForGitHubRun",
      input: { id: 42, repo, intervalMs: 999 },
      error: "intervalMs must be an integer between 1000 and 30000",
    },
    {
      name: "waitForGitHubRun initialDelayMs above 120000",
      fn: "waitForGitHubRun",
      input: { id: 42, repo, initialDelayMs: 120_001 },
      error: "initialDelayMs must be an integer between 0 and 120000",
    },
    {
      name: "waitForGitHubRun NaN attempts",
      fn: "waitForGitHubRun",
      input: { id: 42, repo, attempts: Number.NaN },
      error: "attempts must be an integer between 1 and 120",
    },
    {
      name: "waitForGitHubRunForCommit discoveryAttempts above 12",
      fn: "waitForGitHubRunForCommit",
      input: { repo, sha, discoveryAttempts: 13 },
      error: "discoveryAttempts must be an integer between 1 and 12",
    },
    {
      name: "waitForGitHubRunForCommit infinite discoveryIntervalMs",
      fn: "waitForGitHubRunForCommit",
      input: { repo, sha, discoveryIntervalMs: Number.POSITIVE_INFINITY },
      error: "discoveryIntervalMs must be an integer between 1000 and 30000",
    },
  ])("rejects $name before calling any dependency", async ({ fn, input, error }) => {
    const calls: string[] = [];
    const run = await loadWorkflowFunction(fn);
    await expect(run(recordingDependencies(calls), input)).rejects.toThrow(error);
    expect(calls).toEqual([]);
  });
});
