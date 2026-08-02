/**
 * Runs a bounded targeted Vitest command for explicit Pit test files.
 *
 * @pit project
 * @param input.files - Test files under test/ with names that end in .test.ts.
 */
async function runPitTargetedTests({ shell }, input: { files: string[] }) {
  const files = [...new Set(input.files)];
  if (files.length === 0 || files.length > 20) {
    throw new Error("Provide between 1 and 20 targeted test files");
  }
  const allowed = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._/-";
  const invalid = files.filter(
    (file) =>
      !file.startsWith("test/") ||
      !file.endsWith(".test.ts") ||
      file.split("/").includes("..") ||
      [...file].some((character) => !allowed.includes(character)),
  );
  if (invalid.length > 0) {
    throw new Error(`Targeted tests must be safe test/*.test.ts paths: ${invalid.join(", ")}`);
  }
  const result = await shell.execFile("npx", ["vitest", "run", ...files], {
    raise: false,
    timeoutMs: 150000,
    maxBytes: 30000,
    maxLines: 400,
    truncate: "tail",
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  const summary = output.split("\n").slice(-120).join("\n");
  if (result.code !== 0) {
    throw new Error(`Targeted tests failed with exit ${result.code}:\n\n${summary}`);
  }
  return { files, code: result.code, summary };
}
