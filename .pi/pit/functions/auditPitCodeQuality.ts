/**
 * Runs Pit's maintainability audit and returns bounded structured findings.
 *
 * @pit project
 */
async function auditPitCodeQuality(
  { context, shell },
  input: { limit?: number; kinds?: string[] } = {},
) {
  const runtime = await context.get();
  const limit = Math.max(1, Math.min(input.limit ?? 30, 100));
  const result = await shell.execFile("node", ["scripts/audit-code-size.mjs", "--json"], {
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
