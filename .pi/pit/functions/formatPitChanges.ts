/**
 * Formats only files currently changed in Git that Biome supports.
 *
 * @pit project
 * @param input.checkOnly - Check formatting without writing files.
 */
async function formatPitChanges({ git, shell }, input: { checkOnly?: boolean } = {}) {
  const [unstaged, staged, status] = await Promise.all([
    git.diff(["--name-only"]),
    git.diff(["--cached", "--name-only"]),
    git.status(["--porcelain", "--untracked-files=all"]),
  ]);
  const candidates = [
    ...unstaged.stdout.split("\n"),
    ...staged.stdout.split("\n"),
    ...status.stdout
      .split("\n")
      .filter((line) => line.startsWith("?? "))
      .map((line) => line.slice(3)),
  ];
  const supportedExtensions = [
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mts",
    ".cts",
    ".mjs",
    ".cjs",
    ".json",
    ".jsonc",
  ];
  const files = [...new Set(candidates.map((file) => file.trim()).filter(Boolean))]
    .filter(
      (file) =>
        supportedExtensions.some((extension) => file.endsWith(extension)) && !file.includes(" -> "),
    )
    .slice(0, 100);
  if (files.length === 0) {
    return { files, changed: false, message: "No changed Biome-supported files" };
  }
  const args = ["biome", "format", ...(input.checkOnly ? [] : ["--write"]), ...files];
  const result = await shell.execFile("npx", args, {
    raise: false,
    timeoutMs: 120000,
    maxBytes: 30000,
    maxLines: 400,
    truncate: "tail",
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  if (result.code !== 0 && !input.checkOnly) {
    throw new Error(`Formatting failed with exit ${result.code}:\n\n${output}`);
  }
  return {
    files,
    changed: !input.checkOnly && result.code === 0,
    formatted: result.code === 0,
    output,
    anchorsInvalidated: input.checkOnly ? [] : files,
  };
}
