/**
 * Verifies a published Pit release: its tag commit, the exact asset set (six platform addons, the
 * QuickJS guest, and the checksum manifest), and, optionally, a strict installer run from a fresh
 * clone of the tag that downloads and checksum-verifies this platform's prebuild and loads the addon.
 * The installer check uses a private /tmp/pit-release-* directory and always removes it.
 *
 * @param input.tag - Release tag such as v0.20.0.
 * @param input.repo - GitHub owner/name. The default is cv/pit.
 * @param input.installer - Run the strict installer check. The default is true.
 * @param input.raise - Fail when any check fails. The default is true; false returns the problems.
 */
async function verifyPublished(
  { gh: { releaseView }, shell: { execFile } },
  input: { tag: string; repo?: string; installer?: boolean; raise?: boolean },
) {
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(input.tag)) {
    throw new Error("tag must look like v1.2.3");
  }
  const repo = input.repo ?? "cv/pit";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("repo must be owner/name");
  const clip = (text: string) => (text.length > 400 ? `…${text.slice(-399)}` : text).trim();
  const problems: string[] = [];

  const view = await releaseView(input.tag, {
    repo,
    json: ["tagName", "isDraft", "isPrerelease", "assets", "url"],
    raise: true,
  });
  if (view.truncated) throw new Error("Release view was truncated");
  const release = JSON.parse(view.stdout) as {
    tagName: string;
    isDraft: boolean;
    isPrerelease: boolean;
    url: string;
    assets: { name: string }[];
  };
  if (release.tagName !== input.tag) problems.push(`release tag is ${release.tagName}`);
  if (release.isDraft) problems.push("release is a draft");
  if (release.isPrerelease) problems.push("release is a prerelease");

  const targets = [
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
    "win32-arm64",
    "win32-x64",
  ];
  const expected = [
    ...targets.map((target) => `pit-wasmtime-${target}.node`),
    "pit-queued-quickjs-guest.wasm",
    "pit-wasmtime-checksums.json",
  ];
  const names = release.assets.map((asset) => asset.name);
  const missing = expected.filter((name) => !names.includes(name));
  const extra = names.filter((name) => !expected.includes(name));
  if (missing.length) problems.push(`missing assets: ${missing.join(", ")}`);
  if (extra.length) problems.push(`unexpected assets: ${extra.join(", ")}`);

  const remote = `https://github.com/${repo}.git`;
  const refs = await execFile(
    "git",
    ["ls-remote", remote, `refs/tags/${input.tag}`, `refs/tags/${input.tag}^{}`],
    {
      raise: true,
      timeoutMs: 30000,
    },
  );
  const lines = refs.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"));
  const peeled = lines.find(([, ref]) => ref.endsWith("^{}")) ?? lines[0];
  const commit = peeled?.[0] ?? null;
  if (!commit) problems.push("tag not found on the remote");

  let installer: {
    target: string;
    packageVersion: string;
    code: number;
    output: string;
    marker: string | null;
    exports: string[];
  } | null = null;
  if (input.installer !== false) {
    const dir = (
      await execFile("mktemp", ["-d", "/tmp/pit-release-XXXXXX"], { raise: true })
    ).stdout.trim();
    if (!/^\/tmp\/pit-release-[A-Za-z0-9]+$/.test(dir))
      throw new Error(`unexpected temporary directory ${dir}`);
    try {
      const cwd = `${dir}/pit`;
      await execFile(
        "git",
        ["clone", "--quiet", "--depth", "1", "--branch", input.tag, remote, cwd],
        {
          raise: true,
          timeoutMs: 120000,
        },
      );
      const node = (script: string, args: string[] = []) =>
        execFile("node", ["-e", script, ...args], { cwd, raise: true, timeoutMs: 30000 });
      const packageVersion = (await node("process.stdout.write(require('./package.json').version)"))
        .stdout;
      if (`v${packageVersion}` !== input.tag)
        problems.push(`tagged package.json is ${packageVersion}`);
      const target = (await node("process.stdout.write(process.platform + '-' + process.arch)"))
        .stdout;
      const run = await execFile(
        "env",
        [
          "-u",
          "PIT_WASMTIME_ADDON",
          "-u",
          "PIT_WASMTIME_COMPONENT",
          "-u",
          "PIT_SKIP_WASMTIME_INSTALL",
          "-u",
          "PIT_WASMTIME_RELEASE_URL",
          "PIT_WASMTIME_INSTALL_STRICT=1",
          "node",
          "scripts/install-wasmtime.mjs",
        ],
        { cwd, timeoutMs: 180000, maxBytes: 20000 },
      );
      if (run.code !== 0) problems.push(`strict installer exited ${run.code}`);
      const prebuilds = `${cwd}/native/prebuilds/${target}`;
      const markerResult = await execFile("cat", [`${prebuilds}/pit-release.json`]);
      const marker = markerResult.code === 0 ? markerResult.stdout.trim() : null;
      let markerVersion: string | undefined;
      try {
        markerVersion = marker ? (JSON.parse(marker) as { version?: string }).version : undefined;
      } catch {
        markerVersion = undefined;
      }
      if (`v${markerVersion}` !== input.tag)
        problems.push(`installed prebuild marker is ${marker ?? "missing"}`);
      const loaded = await execFile(
        "node",
        [
          "-e",
          "process.stdout.write(Object.keys(require(process.argv[1])).sort().join(','))",
          `${prebuilds}/pit_wasmtime_executor.node`,
        ],
        { cwd, timeoutMs: 30000 },
      );
      const exports = loaded.code === 0 ? loaded.stdout.split(",").filter(Boolean) : [];
      if (!exports.includes("executeQueuedJavascript"))
        problems.push("installed addon did not load");
      installer = {
        target,
        packageVersion,
        code: run.code,
        output: clip(run.stdout + run.stderr),
        marker,
        exports,
      };
    } finally {
      await execFile("rm", ["-rf", dir], { raise: true });
    }
  }

  const ok = problems.length === 0;
  if (!ok && input.raise !== false) {
    throw new Error(`Release ${input.tag} failed verification: ${problems.join("; ")}`);
  }
  return {
    ok,
    problems,
    tag: input.tag,
    url: release.url,
    commit,
    assets: { count: names.length, missing, extra },
    installer,
  };
}
