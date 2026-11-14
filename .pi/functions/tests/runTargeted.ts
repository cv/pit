/**
 * Runs a bounded targeted Vitest command for explicit Pit test files and returns structured
 * results. Failures, suite load errors, and optional timings come from Vitest's JSON report, so
 * many simultaneous failures stay compact and the first ones are never lost to an output tail.
 *
 * @param input.files - Test files under test/ with names that end in .test.ts.
 * @param input.testNamePattern - Optional Vitest -t name pattern (one line, 1-200 characters).
 * @param input.slowest - Slowest files and tests to report (0-20). The default is 0.
 * @param input.raise - Fail when tests fail. The default is true; false returns the failures.
 */
async function runTargeted(
  { shell: { execFile }, jq },
  input: { files: string[]; testNamePattern?: string; slowest?: number; raise?: boolean },
) {
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
  const pattern = input.testNamePattern;
  if (
    pattern !== undefined &&
    (pattern.length === 0 || pattern.length > 200 || /[\r\n\0]/.test(pattern))
  ) {
    throw new Error("testNamePattern must be one line of 1-200 characters");
  }
  const slowest = input.slowest ?? 0;
  if (!Number.isInteger(slowest) || slowest < 0 || slowest > 20) {
    throw new Error("slowest must be an integer between 0 and 20");
  }
  const raise = input.raise ?? true;
  const FAILURE_LIMIT = 15;
  const SUITE_ERROR_LIMIT = 5;
  const MESSAGE_LINES = 8;
  const LINE_CHARS = 160;
  type Report = {
    counts: { files: number; tests: number; passed: number; failed: number; skipped: number };
    failures: Array<{ file: string; test: string; line: number | null; message: string }>;
    failuresOmitted: number;
    suiteErrors: Array<{ file: string; message: string }>;
    suiteErrorsOmitted: number;
    slowestFiles: Array<{ file: string; ms: number }>;
    slowestTests: Array<{ file: string; test: string; ms: number }>;
  };
  // Vitest creates the directory; node_modules/.vitest is its ignored cache location.
  const reportFile = `node_modules/.vitest/pit-targeted-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.json`;
  const filter = `
    def clip: split("\\n")
      | map(select(test("^ *at .*(node_modules|node:internal|<anonymous>)") | not) | .[0:$chars])
      | .[0:$lines] | join("\\n");
    [.testResults[] | .name as $file | .assertionResults[] | select(.status == "failed")
      | {file: $file, test: .fullName, line: (.location.line // null),
         message: ((.failureMessages // []) | join("\\n") | clip)}] as $failures
    | [.testResults[]
      | select(.status == "failed" and ([.assertionResults[] | select(.status == "failed")] | length) == 0)
      | {file: .name, message: ((.message // "") | clip)}] as $suiteErrors
    | {
        counts: {
          files: (.testResults | length),
          tests: .numTotalTests,
          passed: .numPassedTests,
          failed: .numFailedTests,
          skipped: ((.numPendingTests // 0) + (.numTodoTests // 0))
        },
        failures: $failures[0:$failureLimit],
        failuresOmitted: ([($failures | length) - $failureLimit, 0] | max),
        suiteErrors: $suiteErrors[0:$suiteErrorLimit],
        suiteErrorsOmitted: ([($suiteErrors | length) - $suiteErrorLimit, 0] | max),
        slowestFiles: ([.testResults[] | {file: .name, ms: (((.endTime // 0) - (.startTime // 0)) | floor)}]
          | sort_by(-.ms) | .[0:$slowest]),
        slowestTests: ([.testResults[] | .name as $file | .assertionResults[] | select(.duration != null)
          | {file: $file, test: .fullName, ms: (.duration | floor)}] | sort_by(-.ms) | .[0:$slowest])
      }`;

  const result = await execFile(
    "npx",
    [
      "vitest",
      "run",
      "--reporter=default",
      "--reporter=json",
      `--outputFile.json=${reportFile}`,
      ...(pattern === undefined ? [] : ["-t", pattern]),
      ...files,
    ],
    { raise: false, timeoutMs: 150000, maxBytes: 30000, maxLines: 400, truncate: "tail" },
  );
  let report: Report | undefined;
  try {
    report = await jq({
      file: reportFile,
      filter,
      variables: {
        chars: LINE_CHARS,
        lines: MESSAGE_LINES,
        failureLimit: FAILURE_LIMIT,
        suiteErrorLimit: SUITE_ERROR_LIMIT,
        slowest,
      },
    }).then(
      (parsed) => parsed.values[0] as Report | undefined,
      () => undefined,
    );
  } finally {
    await execFile("rm", ["-f", "--", reportFile], { raise: false });
  }

  // Built from a character code so the linted source contains no control character.
  const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
  const clean = (text: string) => text.replace(ansi, "");
  // Vitest reports absolute paths; strip the repository root from paths and messages.
  const root = [
    ...(report?.failures ?? []),
    ...(report?.suiteErrors ?? []),
    ...(report?.slowestFiles ?? []),
  ]
    .map(({ file: name }) => {
      const match = files.find((file) => name.endsWith(`/${file}`));
      return match ? name.slice(0, name.length - match.length) : undefined;
    })
    .find((prefix) => prefix !== undefined);
  const shorten = (text: string) => (root ? text.split(root).join("") : text);
  const relative = (name: string) =>
    files.find((file) => name === file || name.endsWith(`/${file}`)) ?? name;
  const indent = (text: string) =>
    text
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n");
  const outputLines = clean([result.stdout, result.stderr].filter(Boolean).join("\n").trim())
    .split("\n")
    .filter((line) => !line.startsWith("JSON report written to"));
  if (!report) {
    const summary = outputLines.slice(-120).join("\n");
    if (result.code !== 0) {
      throw new Error(
        `Targeted tests failed with exit ${result.code} and wrote no JSON report:\n\n${summary}`,
      );
    }
    return { files, code: result.code, summary };
  }

  const failures = report.failures.map((failure) => ({
    ...failure,
    file: relative(failure.file),
    message: shorten(clean(failure.message)),
  }));
  const suiteErrors = report.suiteErrors.map((error) => ({
    file: relative(error.file),
    message: shorten(clean(error.message)),
  }));
  const outcome = {
    files,
    code: result.code,
    summary: outputLines.slice(-40).join("\n"),
    counts: report.counts,
    failures,
    failuresOmitted: report.failuresOmitted,
    suiteErrors,
    suiteErrorsOmitted: report.suiteErrorsOmitted,
    ...(slowest > 0
      ? {
          slowestFiles: report.slowestFiles.map((entry) => ({
            ...entry,
            file: relative(entry.file),
          })),
          slowestTests: report.slowestTests.map((entry) => ({
            ...entry,
            file: relative(entry.file),
          })),
        }
      : {}),
  };
  if (result.code === 0 || !raise) return outcome;

  const { counts } = report;
  const sections = [
    `Targeted tests failed with exit ${result.code}: ${counts.failed} failed, ${counts.passed} passed, ${counts.skipped} skipped across ${counts.files} files.`,
  ];
  if (suiteErrors.length > 0) {
    sections.push(
      [
        "Suite errors:",
        ...suiteErrors.map((error) => `- ${error.file}\n${indent(error.message)}`),
        ...(report.suiteErrorsOmitted > 0
          ? [`(${report.suiteErrorsOmitted} more suite errors omitted)`]
          : []),
      ].join("\n"),
    );
  }
  if (failures.length > 0) {
    sections.push(
      [
        "Failures:",
        ...failures.map(
          (failure) =>
            `- ${failure.file}${failure.line === null ? "" : `:${failure.line}`} › ${failure.test}\n${indent(failure.message)}`,
        ),
        ...(report.failuresOmitted > 0
          ? [`(${report.failuresOmitted} more failures omitted)`]
          : []),
      ].join("\n"),
    );
  }
  if (suiteErrors.length === 0 && failures.length === 0) {
    sections.push(
      `No failing test was reported. Output tail:\n${outputLines.slice(-60).join("\n")}`,
    );
  }
  throw new Error(sections.join("\n\n"));
}
