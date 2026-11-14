/**
 * Formats only files currently changed in Git that Oxfmt supports.
 *
 * @param input.checkOnly - Check formatting without writing files.
 */
async function format(
  { delivery: { listChangedFiles }, shell: { execFile } },
  input: { checkOnly?: boolean } = {},
) {
  const { files: candidates } = await listChangedFiles();
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
    ".yaml",
    ".yml",
    ".toml",
    ".html",
    ".md",
    ".mdx",
    ".css",
    ".scss",
    ".less",
  ];
  const files = candidates.filter((file) =>
    supportedExtensions.some((extension) => file.endsWith(extension)),
  );
  if (files.length > 100) {
    throw new Error(
      "More than 100 formattable files; narrow the worktree instead of formatting a partial list",
    );
  }
  if (files.length === 0) {
    return { files, changed: false, message: "No changed Oxfmt-supported files" };
  }
  const args = ["oxfmt", input.checkOnly ? "--check" : "--write", "--", ...files];
  const result = await execFile("npx", args, {
    raise: false,
    timeoutMs: 120000,
    maxBytes: 30000,
    maxLines: 400,
    truncate: "tail",
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  if (result.code !== 0 && !input.checkOnly) {
    throw new Error(
      `Formatting failed with exit ${result.code}; re-read all attempted files before editing:\n\n${output}`,
    );
  }
  return {
    files,
    changed: !input.checkOnly && result.code === 0,
    formatted: result.code === 0,
    output,
    anchorsInvalidated: input.checkOnly ? [] : files,
  };
}
