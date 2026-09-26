/**
 * Runs Pit's maintainability audit and returns bounded structured findings.
 *
 * @param input.limit - Maximum findings to return (1-100). The default is 30.
 */
async function auditCodeQuality(
  { context: { get }, shell: { execFile } },
  input: { limit?: number; kinds?: string[] } = {},
) {
  const limit = input.limit ?? 30;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("limit must be an integer between 1 and 100");
  }
  const runtime = await get();
  const result = await execFile("node", ["scripts/audit-code-size.mjs", "--json"], {
    cwd: runtime.cwd,
    timeoutMs: 30000,
    maxLines: 1000,
    maxBytes: 40000,
    raise: true,
  });
  const report = JSON.parse(result.stdout) as {
    thresholds: Record<string, number>;
    findings: Array<{
      kind: string;
      file: string;
      name: string;
      lines: number;
      score: number;
    }>;
  };
  const kinds = input.kinds?.length ? new Set(input.kinds) : undefined;
  const findings = report.findings
    .filter((finding) => !kinds || kinds.has(finding.kind))
    .slice(0, limit);
  return {
    thresholds: report.thresholds,
    total: report.findings.length,
    matched: findings.length,
    truncated: report.findings.length > findings.length,
    findings,
  };
}
