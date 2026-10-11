/**
 * Verifies a published Pit release: its tag commit, that it carries no assets (Pit installs from
 * the tagged source), and, optionally, an install check from a fresh clone of the tag that installs
 * the runtime dependencies and runs a script in the codemode sandbox. The install check uses a
 * private /tmp/pit-release-* directory and always removes it.
 *
 * @param input.tag - Release tag such as v0.20.0.
 * @param input.repo - GitHub owner/name. The default is cv/pit.
 * @param input.install - Run the install check. The default is true.
 * @param input.raise - Fail when any check fails. The default is true; false returns the problems.
 */
async function verifyPublished(
  { gh: { releaseView }, shell: { execFile } },
  input: { tag: string; repo?: string; install?: boolean; raise?: boolean },
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
  const assets = release.assets.map((asset) => asset.name);
  if (assets.length) problems.push(`unexpected assets: ${assets.join(", ")}`);

  const remote = `https://github.com/${repo}.git`;
  const refs = await execFile(
    "git",
    ["ls-remote", remote, `refs/tags/${input.tag}`, `refs/tags/${input.tag}^{}`],
    { raise: true, timeoutMs: 30000 },
  );
  const lines = refs.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"));
  const peeled = lines.find(([, ref]) => ref.endsWith("^{}")) ?? lines[0];
  const commit = peeled?.[0] ?? null;
  if (!commit) problems.push("tag not found on the remote");

  let install: { packageVersion: string; code: number; output: string; sandbox: string } | null =
    null;
  if (input.install !== false) {
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
        { raise: true, timeoutMs: 120000 },
      );
      const packageVersion = (
        await execFile("node", ["-e", "process.stdout.write(require('./package.json').version)"], {
          cwd,
          raise: true,
          timeoutMs: 30000,
        })
      ).stdout;
      if (`v${packageVersion}` !== input.tag)
        problems.push(`tagged package.json is ${packageVersion}`);
      // The dependencies Pi installs with the package, without development dependencies.
      const run = await execFile("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], {
        cwd,
        timeoutMs: 180000,
        maxBytes: 20000,
      });
      if (run.code !== 0) problems.push(`npm ci exited ${run.code}`);
      const probe = await execFile(
        "node",
        [
          "--input-type=module",
          "-e",
          "const { CodemodeSandbox } = await import('@earendil-works/pi-codemode'); const result = await new CodemodeSandbox().execute('return 1 + 1'); process.stdout.write(JSON.stringify(result.ok ? result.value : result.error.message));",
        ],
        { cwd, timeoutMs: 30000 },
      );
      const sandbox = probe.code === 0 ? probe.stdout.trim() : clip(probe.stderr);
      if (sandbox !== "2") problems.push(`sandbox did not run: ${sandbox}`);
      install = { packageVersion, code: run.code, output: clip(run.stdout + run.stderr), sandbox };
    } finally {
      await execFile("rm", ["-rf", dir], { raise: true });
    }
  }

  const ok = problems.length === 0;
  if (!ok && input.raise !== false) {
    throw new Error(`Release ${input.tag} failed verification: ${problems.join("; ")}`);
  }
  return { ok, problems, tag: input.tag, url: release.url, commit, assets, install };
}
