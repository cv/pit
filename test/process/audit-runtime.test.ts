import { describe, expect, it } from "vitest";

import { filterAudit, type AuditReport } from "../../scripts/audit-runtime.js";

const ignoredUrl = "https://github.com/advisories/GHSA-fc5q-39xc-vjpf";
const otherUrl = "https://github.com/advisories/GHSA-aaaa-bbbb-cccc";

function advisory(url: string) {
  return { source: 1, name: "x", title: "t", url, severity: "high" };
}

describe("filterAudit", () => {
  it("drops an ignored advisory and the packages vulnerable only through it", () => {
    const report: AuditReport = {
      vulnerabilities: {
        picomatch: { name: "picomatch", severity: "high", via: [advisory(ignoredUrl)] },
        fdir: { name: "fdir", severity: "high", via: ["picomatch"] },
        tinyglobby: { name: "tinyglobby", severity: "high", via: ["fdir", "picomatch"] },
      },
    };
    expect(filterAudit(report, new Set(["GHSA-fc5q-39xc-vjpf"]))).toEqual({
      remaining: [],
      ignored: ["GHSA-fc5q-39xc-vjpf"],
    });
  });

  it("keeps packages with another advisory, directly or through a dependency", () => {
    const report: AuditReport = {
      vulnerabilities: {
        picomatch: {
          name: "picomatch",
          severity: "high",
          via: [advisory(ignoredUrl), advisory(otherUrl)],
        },
        fdir: { name: "fdir", severity: "high", via: ["picomatch"] },
      },
    };
    const outcome = filterAudit(report, new Set(["GHSA-fc5q-39xc-vjpf"]));
    expect(outcome.remaining.map((vulnerability) => vulnerability.name)).toEqual([
      "picomatch",
      "fdir",
    ]);
    expect(outcome.remaining[0]?.via).toEqual([advisory(otherUrl)]);
  });

  it("reports every advisory when nothing is ignored", () => {
    const report: AuditReport = {
      vulnerabilities: {
        picomatch: { name: "picomatch", severity: "high", via: [advisory(ignoredUrl)] },
      },
    };
    expect(filterAudit(report, new Set()).remaining).toHaveLength(1);
  });
});
