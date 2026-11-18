// Runs `npm audit --omit=dev` and fails on any advisory except the ones listed in IGNORED.
// npm has no built-in ignore list, so withdrawn or reviewed advisories that the registry still
// reports would otherwise fail CI and the release workflow.
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** Advisory IDs to ignore, each with the reason it does not apply. */
export const IGNORED: ReadonlyMap<string, string> = new Map([
  ["GHSA-fc5q-39xc-vjpf", "withdrawn by GitHub: picomatch is not vulnerable (#411)"],
]);

interface Advisory {
  source?: number;
  name?: string;
  title?: string;
  url?: string;
  severity?: string;
}

interface Vulnerability {
  name: string;
  severity: string;
  via: Array<string | Advisory>;
}

export interface AuditReport {
  vulnerabilities?: Record<string, Vulnerability>;
}

export interface AuditOutcome {
  /** Vulnerable packages that remain after removing ignored advisories and their dependents. */
  remaining: Vulnerability[];
  /** Ignored advisory IDs that the report contained. */
  ignored: string[];
}

function advisoryId(advisory: Advisory): string | undefined {
  return advisory.url?.match(/GHSA-[\w-]+$/)?.[0];
}

/**
 * Removes ignored advisories, then every package that was vulnerable only through them, directly
 * or through other packages that no longer count as vulnerable.
 */
export function filterAudit(report: AuditReport, ignored: ReadonlySet<string>): AuditOutcome {
  const seen = new Set<string>();
  let packages = new Map(
    Object.entries(report.vulnerabilities ?? {}).map(([name, vulnerability]) => {
      const via = vulnerability.via.filter((entry) => {
        if (typeof entry === "string") return true;
        const id = advisoryId(entry);
        if (id === undefined || !ignored.has(id)) return true;
        seen.add(id);
        return false;
      });
      return [name, { ...vulnerability, via }];
    }),
  );
  for (;;) {
    const kept = new Map(
      [...packages].filter(([, vulnerability]) =>
        vulnerability.via.some((entry) => typeof entry !== "string" || packages.has(entry)),
      ),
    );
    if (kept.size === packages.size) break;
    packages = kept;
  }
  return { remaining: [...packages.values()], ignored: [...seen].sort() };
}

function describe(vulnerability: Vulnerability): string {
  const reasons = vulnerability.via.map((entry) =>
    typeof entry === "string" ? `depends on ${entry}` : `${entry.title ?? "advisory"} ${entry.url ?? ""}`.trim(),
  );
  return `${vulnerability.name} (${vulnerability.severity}): ${reasons.join("; ")}`;
}

function main(): number {
  const result = spawnSync("npm", ["audit", "--omit=dev", "--json"], { encoding: "utf8" });
  let report: AuditReport & { error?: unknown };
  try {
    report = JSON.parse(result.stdout) as AuditReport & { error?: unknown };
  } catch {
    process.stderr.write(`npm audit returned unreadable output:\n${result.stdout}${result.stderr}`);
    return 1;
  }
  if (report.error !== undefined) {
    process.stderr.write(`npm audit failed: ${JSON.stringify(report.error)}\n`);
    return 1;
  }
  const outcome = filterAudit(report, new Set(IGNORED.keys()));
  for (const id of outcome.ignored) process.stdout.write(`Ignored ${id}: ${IGNORED.get(id)}\n`);
  if (outcome.remaining.length > 0) {
    process.stderr.write(
      `Runtime dependency audit found ${outcome.remaining.length} vulnerable packages:\n- ${outcome.remaining.map(describe).join("\n- ")}\n`,
    );
    return 1;
  }
  process.stdout.write("Runtime dependency audit found no unignored vulnerabilities.\n");
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = main();
