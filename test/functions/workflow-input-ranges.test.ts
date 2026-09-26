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
      name: "sessions.analyze examples above 30",
      fn: "sessions.analyze",
      input: { file: "session.jsonl", examples: 31 },
      error: "examples must be an integer between 1 and 30",
    },
    {
      name: "sessions.analyzeRecent limit of 0",
      fn: "sessions.analyzeRecent",
      input: { limit: 0 },
      error: "limit must be an integer between 1 and 20",
    },
    {
      name: "delivery.auditCodeQuality limit above 100",
      fn: "delivery.auditCodeQuality",
      input: { limit: 101 },
      error: "limit must be an integer between 1 and 100",
    },
    {
      name: "ci.findRun limit above 100",
      fn: "ci.findRun",
      input: { repo, sha, limit: 101 },
      error: "limit must be an integer between 1 and 100",
    },
    {
      name: "tests.inspectCoverageGaps limit above 500",
      fn: "tests.inspectCoverageGaps",
      input: { limit: 501 },
      error: "limit must be an integer between 1 and 500",
    },
    {
      name: "delivery.review diffLines below 20",
      fn: "delivery.review",
      input: { diffLines: 19 },
      error: "diffLines must be an integer between 20 and 800",
    },
    {
      name: "delivery.review diffBytes above 20000",
      fn: "delivery.review",
      input: { diffBytes: 20_001 },
      error: "diffBytes must be an integer between 1000 and 20000",
    },
    {
      name: "delivery.review fractional commits",
      fn: "delivery.review",
      input: { commits: 2.5 },
      error: "commits must be an integer between 1 and 20",
    },
    {
      name: "ci.waitForRun intervalMs below 1000",
      fn: "ci.waitForRun",
      input: { id: 42, repo, intervalMs: 999 },
      error: "intervalMs must be an integer between 1000 and 30000",
    },
    {
      name: "ci.waitForRun initialDelayMs above 120000",
      fn: "ci.waitForRun",
      input: { id: 42, repo, initialDelayMs: 120_001 },
      error: "initialDelayMs must be an integer between 0 and 120000",
    },
    {
      name: "ci.waitForRun NaN attempts",
      fn: "ci.waitForRun",
      input: { id: 42, repo, attempts: Number.NaN },
      error: "attempts must be an integer between 1 and 120",
    },
    {
      name: "ci.waitForCommit discoveryAttempts above 12",
      fn: "ci.waitForCommit",
      input: { repo, sha, discoveryAttempts: 13 },
      error: "discoveryAttempts must be an integer between 1 and 12",
    },
    {
      name: "ci.waitForCommit infinite discoveryIntervalMs",
      fn: "ci.waitForCommit",
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
