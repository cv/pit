import { describe, expect, it, vi } from "vitest";

import { loadWorkflowFunction, processResult } from "../helpers/workflow-function.js";

const tag = "v1.2.3";
const dir = "/tmp/pit-release-abc123";

interface Release {
  tagName?: string;
  isDraft?: boolean;
  isPrerelease?: boolean;
  assets?: string[];
}
interface Host {
  lsRemote?: string;
  tempDir?: string;
  cloneFails?: boolean;
  packageVersion?: string;
  installCode?: number;
  sandbox?: { code: number; stdout?: string; stderr?: string };
}

function dependencies(release: Release = {}, host: Host = {}) {
  const releaseView = vi.fn().mockResolvedValue(
    processResult({
      stdout: JSON.stringify({
        tagName: release.tagName ?? tag,
        isDraft: release.isDraft ?? false,
        isPrerelease: release.isPrerelease ?? false,
        url: `https://github.com/cv/pit/releases/tag/${tag}`,
        assets: (release.assets ?? []).map((name) => ({ name })),
      }),
    }),
  );
  const execFile = vi.fn(async (program: string, args: string[], _options?: object) => {
    if (program === "git" && args[0] === "ls-remote") {
      return processResult({
        stdout: host.lsRemote ?? `1111111\trefs/tags/${tag}\n2222222\trefs/tags/${tag}^{}\n`,
      });
    }
    if (program === "mktemp") return processResult({ stdout: `${host.tempDir ?? dir}\n` });
    if (program === "git" && args[0] === "clone") {
      if (host.cloneFails) throw new Error("clone failed");
      return processResult();
    }
    if (program === "node" && args[1]?.includes("package.json")) {
      return processResult({ stdout: host.packageVersion ?? "1.2.3" });
    }
    if (program === "npm")
      return processResult({ code: host.installCode ?? 0, stdout: "added 9\n" });
    if (program === "node" && args.some((arg) => arg.includes("CodemodeSandbox"))) {
      // A flag the sandbox's worker would inherit and reject.
      if (args.includes("--input-type=module")) {
        return processResult({ stdout: '"--input-type can only be used with string input"' });
      }
      return processResult(host.sandbox ?? { code: 0, stdout: "2" });
    }
    if (program === "rm") return processResult();
    throw new Error(`unexpected ${program} ${args.join(" ")}`);
  });
  return { releaseView, execFile, deps: { gh: { releaseView }, shell: { execFile } } };
}

const programs = (execFile: ReturnType<typeof vi.fn>) =>
  execFile.mock.calls.map(([program]) => program as string);

describe("release.verifyPublished", () => {
  it("verifies a release by installing its tag and running the sandbox, then removes its directory", async () => {
    const verify = await loadWorkflowFunction("release.verifyPublished");
    const { execFile, deps } = dependencies();
    const result = await verify(deps, { tag });
    expect(result).toMatchObject({
      ok: true,
      problems: [],
      commit: "2222222",
      assets: [],
      install: { packageVersion: "1.2.3", code: 0, sandbox: "2" },
    });
    expect(execFile).toHaveBeenCalledWith(
      "git",
      [
        "clone",
        "--quiet",
        "--depth",
        "1",
        "--branch",
        tag,
        "https://github.com/cv/pit.git",
        `${dir}/pit`,
      ],
      expect.anything(),
    );
    const install = execFile.mock.calls.find(([program]) => program === "npm");
    expect(install?.[1]).toEqual(expect.arrayContaining(["ci", "--omit=dev"]));
    expect(install?.[2]).toMatchObject({ cwd: `${dir}/pit` });
    expect(execFile.mock.calls.at(-1)).toEqual(["rm", ["-rf", dir], { raise: true }]);
  });

  it.each<{ name: string; lsRemote: string; commit: string | null }>([
    {
      name: "the peeled commit of an annotated tag",
      lsRemote: `1111111\trefs/tags/${tag}\n2222222\trefs/tags/${tag}^{}\n`,
      commit: "2222222",
    },
    {
      name: "the commit of a lightweight tag",
      lsRemote: `3333333\trefs/tags/${tag}\n`,
      commit: "3333333",
    },
  ])("reports $name", async ({ lsRemote, commit }) => {
    const verify = await loadWorkflowFunction("release.verifyPublished");
    const { deps } = dependencies({}, { lsRemote });
    expect(await verify(deps, { tag, install: false })).toMatchObject({ ok: true, commit });
  });

  it.each<{ name: string; release?: Release; host?: Host; problem: string }>([
    { name: "a draft release", release: { isDraft: true }, problem: "release is a draft" },
    { name: "a prerelease", release: { isPrerelease: true }, problem: "release is a prerelease" },
    {
      name: "an attached asset",
      release: { assets: ["pit-wasmtime-linux-x64.node"] },
      problem: "unexpected assets: pit-wasmtime-linux-x64.node",
    },
    {
      name: "a tag absent from the remote",
      host: { lsRemote: "" },
      problem: "tag not found on the remote",
    },
    {
      name: "a tagged package version mismatch",
      host: { packageVersion: "1.2.2" },
      problem: "tagged package.json is 1.2.2",
    },
    { name: "a failed install", host: { installCode: 1 }, problem: "npm ci exited 1" },
    {
      name: "a sandbox that does not load",
      host: { sandbox: { code: 1, stderr: "Cannot find package 'quickjs-wasi'" } },
      problem: "sandbox did not run: Cannot find package 'quickjs-wasi'",
    },
  ])("reports $name and still removes its directory", async ({ release, host, problem }) => {
    const verify = await loadWorkflowFunction("release.verifyPublished");
    const { execFile, deps } = dependencies(release, host);
    const result = await verify(deps, { tag, raise: false });
    expect(result).toMatchObject({ ok: false, problems: [problem] });
    expect(execFile.mock.calls.at(-1)).toEqual(["rm", ["-rf", dir], { raise: true }]);
  });

  it("raises every problem by default", async () => {
    const verify = await loadWorkflowFunction("release.verifyPublished");
    const { deps } = dependencies({ isDraft: true, assets: ["notes.txt"] });
    await expect(verify(deps, { tag, install: false })).rejects.toThrow(
      `Release ${tag} failed verification: release is a draft; unexpected assets: notes.txt`,
    );
  });

  it("removes its directory when the clone fails", async () => {
    const verify = await loadWorkflowFunction("release.verifyPublished");
    const { execFile, deps } = dependencies({}, { cloneFails: true });
    await expect(verify(deps, { tag })).rejects.toThrow("clone failed");
    expect(execFile.mock.calls.at(-1)).toEqual(["rm", ["-rf", dir], { raise: true }]);
  });

  it("never removes a temporary path outside /tmp/pit-release-*", async () => {
    const verify = await loadWorkflowFunction("release.verifyPublished");
    const { execFile, deps } = dependencies({}, { tempDir: "/tmp/other" });
    await expect(verify(deps, { tag })).rejects.toThrow(
      "unexpected temporary directory /tmp/other",
    );
    expect(programs(execFile)).not.toContain("rm");
  });

  it("does no temporary work when the install check is disabled", async () => {
    const verify = await loadWorkflowFunction("release.verifyPublished");
    const { execFile, deps } = dependencies();
    expect(await verify(deps, { tag, install: false })).toMatchObject({ ok: true, install: null });
    expect(programs(execFile)).toEqual(["git"]);
  });

  it.each<{ name: string; input: Record<string, unknown>; error: string }>([
    {
      name: "a tag without the v prefix",
      input: { tag: "1.2.3" },
      error: "tag must look like v1.2.3",
    },
    {
      name: "a repository without an owner",
      input: { tag, repo: "pit" },
      error: "repo must be owner/name",
    },
  ])("rejects $name before any call", async ({ input, error }) => {
    const verify = await loadWorkflowFunction("release.verifyPublished");
    const { releaseView, execFile, deps } = dependencies();
    await expect(verify(deps, input)).rejects.toThrow(error);
    expect(releaseView).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
  });
});
