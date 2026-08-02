/**
 * Reports bounded uncovered-line and branch markers from Pit's generated coverage HTML.
 *
 * @pit project
 * @param input.files - Optional source paths such as src/index.ts.
 * @param input.limit - Maximum uncovered markers. The default is 100.
 */
async function inspectPitCoverageGaps(
  { workspace },
  input: { files?: string[]; limit?: number } = {},
) {
  const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
  const requested = new Set(input.files ?? []);
  const [summaryResult, searchResult] = await Promise.all([
    workspace
      .read("coverage/coverage-summary.json", { format: "raw" })
      .then((result) => JSON.parse(result.content))
      .catch(() => undefined),
    workspace
      .search("cbranch-no|cstat-no|fstat-no", {
        path: "coverage",
        glob: "**/*.ts.html",
        regex: true,
        contextLines: 0,
        limit,
      })
      .catch(() => undefined),
  ]);
  if (!summaryResult && !searchResult) {
    return {
      available: false,
      message: "Coverage artifacts are unavailable. Run validatePit({ coverage: true }) first.",
    };
  }
  const decode = (text: string) =>
    text
      .replace(/<[^>]+>/g, "")
      .replaceAll("&gt;", ">")
      .replaceAll("&lt;", "<")
      .replaceAll("&amp;", "&")
      .replaceAll("&quot;", '"')
      .trim();
  const sourceFile = (file: string) => {
    const relative = file.startsWith("coverage/") ? file.slice(9) : file;
    return relative.endsWith(".html") ? relative.slice(0, -5) : relative;
  };
  const gaps = (searchResult?.matches ?? [])
    .map((match) => ({
      file: sourceFile(match.file),
      coverageFile: match.file,
      coverageLine: match.line,
      kind: match.text.includes("cbranch-no")
        ? "branch"
        : match.text.includes("fstat-no")
          ? "function"
          : "statement",
      code: decode(match.text),
    }))
    .filter((gap) => requested.size === 0 || requested.has(gap.file));
  const totals = summaryResult?.total;
  return {
    available: true,
    totals: totals
      ? {
          statements: totals.statements?.pct,
          branches: totals.branches?.pct,
          functions: totals.functions?.pct,
          lines: totals.lines?.pct,
        }
      : undefined,
    gaps,
    truncated: Boolean(searchResult?.truncated) || gaps.length >= limit,
  };
}
