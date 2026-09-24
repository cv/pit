/** Runs one guarded literal source mutation through a temporary Vite transform and explicit targeted tests without rewriting the owner. Requires a passing baseline; reports bounded failures, omissions, and inconclusive runs. Uses /tmp, removes its temporary artifacts, and preserves runner/cleanup errors. */
async function probePitAuditMutation(
  { context: { get }, workspace: { edit, read }, shell: { execFile }, jq },
  input: {
    label: string;
    owner: string;
    before: string;
    after: string;
    files: string[];
    testNamePattern?: string;
  },
) {
  const allowed = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._/-";
  const safePath = (file: string, prefix: string, suffix: string) =>
    file.length <= 240 &&
    file.startsWith(prefix) &&
    file.endsWith(suffix) &&
    [...file].every((char) => allowed.includes(char)) &&
    file.split("/").every((part) => part !== "" && part !== "." && part !== "..");
  if (!safePath(input.owner, "src/", ".ts"))
    throw new Error("Expected an explicit source owner path");
  if (!input.label.trim() || input.label.length > 200)
    throw new Error("label must contain 1-200 characters");
  if (
    !input.before ||
    input.before === input.after ||
    input.before.length > 100000 ||
    input.after.length > 100000
  )
    throw new Error("Provide a nontrivial mutation of at most 100000 characters per side");
  if (
    !input.files.length ||
    input.files.length > 10 ||
    input.files.some((file) => !safePath(file, "test/", ".test.ts"))
  )
    throw new Error("Expected 1-10 explicit test files, without globs or traversal");
  const pattern = input.testNamePattern;
  if (pattern !== undefined) {
    if (
      pattern.length === 0 ||
      pattern.length > 200 ||
      ["\r", "\n", "\0"].some((char) => pattern.includes(char))
    )
      throw new Error("testNamePattern must be one line of 1-200 characters");
    try {
      RegExp(pattern);
    } catch {
      throw new Error("testNamePattern must be a valid regular expression");
    }
  }
  const files = [...new Set(input.files)];
  const { cwd } = await get();
  const id = `pit-audit-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const configFile = `/tmp/${id}.config.mjs`;
  const reportFile = `/tmp/${id}.json`;
  const marker = `APPLIED_${id}`;
  const mutation = {
    owner: `${cwd}/${input.owner}`,
    before: input.before,
    after: input.after,
    marker,
  };
  const content = [
    `import base from ${JSON.stringify(`${cwd}/vitest.config.ts`)};`,
    `const mutation = ${JSON.stringify(mutation)};`,
    `export default { ...base, root: ${JSON.stringify(cwd)}, plugins: [...(base.plugins ?? []), {`,
    'name: "pit-audit-mutation", enforce: "pre",',
    "transform(source, id) {",
    "if (id !== mutation.owner) return;",
    'if (source.split(mutation.before).length !== 2) throw new Error("Expected exactly one audit mutation match");',
    "console.error(mutation.marker);",
    "return { code: source.replace(mutation.before, () => mutation.after), map: null };",
    "} }] };",
  ].join("\n");
  const filter = String.raw`
    if (.testResults | type) != "array" then error("Missing Vitest testResults") else . end
    | [.testResults[] | .assertionResults[] | select(.status == "failed")
      | (.failureMessages // [] | join("\n")) as $full
      | ($full | split("\n") | .[0:4] | map(.[0:200]) | join("\n")) as $short
      | {name: (.fullName[0:200]), nameTruncated: ((.fullName | length) > 200),
         reason: $short, reasonTruncated: ($short != $full)}] as $failures
    | [.testResults[] | select(.status == "failed" and
         ([.assertionResults[] | select(.status == "failed")] | length) == 0)
      | {file: (.name[0:240]), fileTruncated: ((.name | length) > 240),
         message: ((.message // "")[0:1000]),
         messageTruncated: (((.message // "") | length) > 1000)}] as $suiteErrors
    | {tests: .numTotalTests, passed: .numPassedTests, failed: .numFailedTests,
       skipped: ((.numPendingTests // 0) + (.numTodoTests // 0)),
       failures: $failures[0:5], failuresOmitted: ([($failures | length) - 5, 0] | max),
       suiteErrors: $suiteErrors[0:3], suiteErrorsOmitted: ([($suiteErrors | length) - 3, 0] | max)}`;
  type Report = {
    tests: number;
    passed: number;
    failed: number;
    skipped: number;
    failures: Array<{
      name: string;
      nameTruncated: boolean;
      reason: string;
      reasonTruncated: boolean;
    }>;
    failuresOmitted: number;
    suiteErrors: Array<{
      file: string;
      fileTruncated: boolean;
      message: string;
      messageTruncated: boolean;
    }>;
    suiteErrorsOmitted: number;
  };
  let outcome:
    | { label: string; code: number; mutationApplied: true; inconclusive: boolean; report: Report }
    | undefined;
  let failure: string | undefined;
  await edit(configFile, { revision: null, changes: [{ kind: "replaceFile", content }] });
  try {
    const result = await execFile(
      "npx",
      [
        "vitest",
        "run",
        ...files,
        "--config",
        configFile,
        "--reporter=json",
        `--outputFile=${reportFile}`,
        ...(pattern === undefined ? [] : ["-t", pattern]),
      ],
      { cwd, timeoutMs: 120000, maxBytes: 8000, maxLines: 80, truncate: "head", raise: false },
    );
    if (!(result.stdout + result.stderr).includes(marker))
      throw new Error(
        `Mutation was not observed in bounded runner output: ${result.stderr.slice(0, 1200)}`,
      );
    const parsed = await jq({ file: reportFile, filter });
    const report = parsed.values[0] as Report | undefined;
    if (
      !report ||
      ![report.tests, report.passed, report.failed, report.skipped].every(
        (value) => Number.isInteger(value) && value >= 0,
      )
    )
      throw new Error("Vitest report has missing or invalid test counts");
    const inconclusive =
      report.passed + report.failed === 0 ||
      report.suiteErrors.length + report.suiteErrorsOmitted > 0 ||
      (result.code !== 0 && report.failed === 0);
    outcome = {
      label: input.label,
      code: result.code,
      mutationApplied: true,
      inconclusive,
      report,
    };
  } catch (error) {
    failure = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
  }
  const cleanupErrors: string[] = [];
  for (const file of [configFile, reportFile]) {
    try {
      const current = await read(file, { format: "raw", limit: 1 });
      await edit(file, { revision: current.revision, changes: [{ kind: "deleteFile" }] });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("ENOENT")) cleanupErrors.push(`${file}: ${message.slice(0, 300)}`);
    }
  }
  if (failure !== undefined || cleanupErrors.length)
    throw new Error(
      [
        failure ?? "Mutation probe completed but temporary-file cleanup failed",
        ...cleanupErrors.map((message) => `Cleanup error: ${message}`),
      ].join("\n"),
    );
  if (!outcome) throw new Error("Mutation probe produced no outcome");
  return outcome;
}
