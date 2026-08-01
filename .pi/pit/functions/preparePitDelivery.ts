/**
 * Validates Pit and reports bounded Git delivery readiness without mutating Git or issues.
 * @pit project
 */
async function preparePitDelivery(
  { git },
  input: { coverage?: boolean; packageCheck?: boolean } = {},
) {
  const validation = await validatePit(input);
  const [status, diffCheck] = await Promise.all([
    git.status(["--short", "--branch"]),
    git.diff(["--check"]),
  ]);
  return {
    validation,
    status: status.stdout.trim(),
    diffCheck: (diffCheck.stdout || diffCheck.stderr).trim(),
    ready: diffCheck.code === 0,
  };
}
