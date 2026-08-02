/**
 * Runs Pit's standard static, test, coverage, and package gates.
 * @pit project
 */
async function validatePit({ npm }, input: { coverage?: boolean; packageCheck?: boolean } = {}) {
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
    npm.run("check", [], processOptions),
    npm.test(processOptions),
  ]);
  const check = gate("check", checkResult);
  const tests = gate("tests", testResult);
  requireSuccess([check, tests]);

  const coverage = input.coverage
    ? gate("coverage", await npm.run("coverage", [], processOptions))
    : undefined;
  if (coverage) {
    requireSuccess([coverage]);
  }
  const packageCheck = input.packageCheck
    ? gate("package:check", await npm.run("package:check", [], processOptions))
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
