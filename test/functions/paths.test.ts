import { homedir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveFunctionPaths } from "../../src/functions/storage/paths.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("function paths", () => {
  it("defaults to .pi/functions and Pi's agent directory", () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/agents/work");
    expect(resolveFunctionPaths("/repo")).toEqual({
      project: join("/repo", ".pi", "functions"),
      user: join("/agents/work", "functions"),
    });
  });

  it.each([
    {
      name: "a project-relative path",
      configured: "tools/pit",
      expected: join("/repo", "tools", "pit"),
    },
    {
      name: "a path outside the project",
      configured: "../shared/pit",
      expected: join("/shared", "pit"),
    },
    { name: "an absolute path", configured: "/opt/pit-functions", expected: "/opt/pit-functions" },
    { name: "a home path", configured: "~/pit/rust", expected: join(homedir(), "pit", "rust") },
    { name: "the home directory", configured: "~", expected: homedir() },
    {
      name: "surrounding whitespace",
      configured: "  ~/pit/python  ",
      expected: join(homedir(), "pit", "python"),
    },
  ])("resolves $name for both keys", ({ configured, expected }) => {
    expect(resolveFunctionPaths("/repo", { project: configured, user: configured })).toEqual({
      project: expected,
      user: expected,
    });
  });

  it("resolves each key on its own", () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/agents/work");
    expect(resolveFunctionPaths("/repo", { user: "~/pit/rust" })).toEqual({
      project: join("/repo", ".pi", "functions"),
      user: join(homedir(), "pit", "rust"),
    });
  });
});
