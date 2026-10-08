/**
 * Runs Pit's standard static, test, coverage, and package gates, after checking that installed
 * direct dependencies match package-lock.json.
 */
async function validate(
  { npm: { run, test }, delivery: { inspectDependencies } },
  input: { coverage?: boolean; packageCheck?: boolean; dependencies?: boolean } = {},
) {
  // A stale node_modules runs the gates against different packages than CI and the lockfile.
  if (input.dependencies !== false) {
    const report = await inspectDependencies({ limit: 30 });
    const stale = report.dependencies.filter((dependency) =>
      report.stale.includes(dependency.name),
    );
    if (stale.length > 0) {
      const lines = stale.map(
        (dependency) =>
          `- ${dependency.name}: declared ${dependency.declared ?? "?"}, locked ${dependency.lockedVersion ?? "none"}, installed ${dependency.installedVersion ?? "none"}`,
      );
      throw new Error(
        `Installed dependencies don't match package-lock.json. Run npm ci (or npm install after changing package.json), or pass dependencies: false for an intentional local override:\n${lines.join("\n")}`,
      );
    }
  }
  type GateResult = { name: string; code: number; stdout: string; stderr: string };
  const gate = (
    name: string,
    result: { code: number; stdout: string; stderr: string },
  ): GateResult => ({ name, code: result.code, stdout: result.stdout, stderr: result.stderr });
  const diagnosticTail = (result: GateResult): string => {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    const tail = output.split("\n").slice(-80).join("\n");
    return tail.length > 12000 ? tail.slice(-12000) : tail;
  };
  const requireSuccess = (gates: GateResult[]): void => {
    const failed = gates.filter((result) => result.code !== 0);
    if (failed.length === 0) {
      return;
    }
    const details = failed
      .map((result) => `${result.name} (exit ${result.code})\n${diagnosticTail(result)}`)
      .join("\n\n");
    throw new Error(`Pit validation failed:\n\n${details}`);
  };
  const processOptions = {
    raise: false,
    timeoutMs: 180000,
    maxBytes: 50000,
    maxLines: 800,
    truncate: "tail" as const,
  };
  const [checkResult, testResult] = await Promise.all([
    run("check", [], processOptions),
    test(processOptions),
  ]);
  const check = gate("check", checkResult);
  const tests = gate("tests", testResult);
  requireSuccess([check, tests]);

  const coverage = input.coverage
    ? gate("coverage", await run("coverage", [], processOptions))
    : undefined;
  if (coverage) {
    requireSuccess([coverage]);
  }
  const packageCheck = input.packageCheck
    ? gate("package:check", await run("package:check", [], processOptions))
    : undefined;
  if (packageCheck) {
    requireSuccess([packageCheck]);
  }
  return {
    check: check.code,
    tests: tests.code,
    coverage: coverage?.code,
    packageCheck: packageCheck?.code,
  };
}
