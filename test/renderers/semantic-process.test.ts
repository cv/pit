import { describe, expect, it } from "vitest";

import { renderGhResult } from "../../src/renderers/gh-result.js";
import { NPM_RESULT_RENDERERS } from "../../src/renderers/npm-result.js";

const theme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => text,
};
const context = { theme, seen: new WeakSet(), depth: 0 } as any;
const result = (stdout: string, code = 0) => ({ stdout, stderr: "", code, truncated: false });

describe("semantic process outcomes", () => {
  it("renders npm audit and outdated findings as warnings", () => {
    const audit = NPM_RESULT_RENDERERS.audit(
      result(JSON.stringify({ metadata: { vulnerabilities: { total: 1, high: 1 } } }), 1),
      context,
    );
    const outdated = NPM_RESULT_RENDERERS.outdated(
      result(JSON.stringify({ pit: { current: "1", latest: "2" } }), 1),
      context,
    );
    expect(audit?.lines[0]).toContain("<warning>exit 1</warning>");
    expect(outdated?.lines[0]).toContain("<warning>exit 1</warning>");
    expect(audit?.outcome).toBe("warning");
    expect(outdated?.outcome).toBe("warning");
  });

  it("renders failed workflow data as a warning while the query succeeds", () => {
    const rendered = renderGhResult(
      result(JSON.stringify([{ databaseId: 1, name: "CI", conclusion: "failure" }])),
      context,
    );
    expect(rendered?.lines[0]).toContain("<warning>exit 0</warning>");
  });

  it("keeps successful plain-text GitHub output successful", () => {
    const rendered = renderGhResult(result("plain output"), context);
    expect(rendered?.lines[0]).toContain("<success>exit 0</success>");
  });

  it("does not let domain data mask unaccepted process failures", () => {
    const emptyAudit = NPM_RESULT_RENDERERS.audit(
      result(JSON.stringify({ metadata: { vulnerabilities: { total: 0 } } }), 1),
      context,
    );
    const emptyOutdated = NPM_RESULT_RENDERERS.outdated(result("{}", 1), context);
    const failedGh = renderGhResult(
      result(JSON.stringify([{ conclusion: "failure" }]), 1),
      context,
    );
    expect(emptyAudit?.lines[0]).toContain("<error>exit 1</error>");
    expect(emptyOutdated?.lines[0]).toContain("<error>exit 1</error>");
    expect(failedGh?.lines[0]).toContain("<error>exit 1</error>");
    expect(emptyAudit?.outcome).toBe("error");
    expect(emptyOutdated?.outcome).toBe("error");
    expect(failedGh?.outcome).toBe("error");
  });
});
