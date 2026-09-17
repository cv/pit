/**
 * Reports bounded uncovered-line and branch markers from Pit's generated coverage HTML.
 *
 * @param input.files - Optional source paths such as src/index.ts.
 * @param input.limit - Maximum uncovered markers. The default is 100.
 */
async function inspectPitCoverageGaps(
  { workspace: { read, search } },
  input: { files?: string[]; limit?: number } = {},
) {
  const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
  const requested = [...new Set(input.files ?? [])];
  const paths =
    requested.length > 0 ? requested.map((file) => `coverage/${file}.html`) : ["coverage"];
  const [summaryResult, searchResults] = await Promise.all([
    read("coverage/coverage-summary.json", { format: "raw" })
      .then((result) => JSON.parse(result.content))
      .catch(() => undefined),
    Promise.all(
      paths.map((path) =>
        search("cbranch-no|cstat-no|fstat-no", {
          path,
          ...(path === "coverage" ? { glob: "**/*.ts.html" } : {}),
          regex: true,
          contextLines: 0,
          limit,
        }).catch(() => undefined),
      ),
    ),
  ]);
  const availableSearches = searchResults.filter(
    (result): result is NonNullable<typeof result> => result !== undefined,
  );
  if (!summaryResult && availableSearches.length === 0) {
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
  const matches = availableSearches.flatMap((result) => result.matches);
  const gaps = matches.slice(0, limit).map((match) => ({
    file: sourceFile(match.file),
    coverageFile: match.file,
    coverageLine: match.line,
    kind: match.text.includes("cbranch-no")
      ? "branch"
      : match.text.includes("fstat-no")
        ? "function"
        : "statement",
    code: decode(match.text),
  }));
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
    truncated: availableSearches.some((result) => result.truncated) || matches.length > gaps.length,
  };
}
