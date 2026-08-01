import { describe, expect, it } from "vitest";
import { renderGhResult } from "../src/gh-result-renderer.js";
import { NPM_RESULT_RENDERERS } from "../src/npm-result-renderers.js";

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
});
