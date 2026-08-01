/**
 * Runs Pit's standard static, test, coverage, and package gates.
 * @pit project
 */
async function validatePit({ npm }, input: { coverage?: boolean; packageCheck?: boolean } = {}) {
  const [check, tests] = await Promise.all([
    npm.run("check", [], { raise: true, timeoutMs: 120000 }),
    npm.test({ raise: true, timeoutMs: 180000 }),
  ]);
  const coverage = input.coverage
    ? await npm.run("coverage", [], { raise: true, timeoutMs: 180000 })
    : undefined;
  const packageCheck = input.packageCheck
    ? await npm.run("package:check", [], { raise: true, timeoutMs: 120000 })
    : undefined;
  return {
    check: check.code,
    tests: tests.code,
    coverage: coverage?.code,
    packageCheck: packageCheck?.code,
  };
}
