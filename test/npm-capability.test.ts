import { describe, expect, it } from "vitest";

import type { CapabilityCall } from "../src/capability-presentation.js";
import { prepareNpmCommand } from "../src/npm-capability.js";
import { renderResultValue } from "../src/renderers/generic.js";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const result = (stdout = "", stderr = "", code = 0, truncated = false) => ({
  stdout,
  stderr,
  code,
  truncated,
});
function render(method: string, value: unknown) {
  const call: CapabilityCall = { capability: "npm", method, qualifiedName: `npm.${method}` };
  const rendered = renderResultValue(value, theme, call);
  if (!rendered) {
    throw new Error("Expected npm result");
  }
  return rendered;
}

describe("npm capability", () => {
  it("prepares scripts and tests", () => {
    expect(prepareNpmCommand("run", ["check", ["--fix"], { raise: true }])).toEqual({
      args: ["run", "check", "--", "--fix"],
      options: { raise: true },
    });
    expect(prepareNpmCommand("run", ["check"])).toEqual({ args: ["run", "check"], options: {} });
    expect(
      prepareNpmCommand("test", [{ coverage: true, args: ["file.ts"], timeoutMs: 10 }]),
    ).toEqual({
      args: ["run", "coverage", "--", "file.ts"],
      options: { timeoutMs: 10 },
    });
    expect(prepareNpmCommand("test", [])).toEqual({ args: ["run", "test"], options: {} });
  });

  it("prepares install and machine-readable inspection commands", () => {
    expect(
      prepareNpmCommand("install", [
        ["pkg"],
        { dev: true, exact: true, packageLockOnly: true, ignoreScripts: true, cwd: "." },
      ]),
    ).toEqual({
      args: [
        "install",
        "--save-dev",
        "--save-exact",
        "--package-lock-only",
        "--ignore-scripts",
        "pkg",
      ],
      options: { cwd: "." },
    });
    expect(prepareNpmCommand("install", [])).toEqual({ args: ["install"], options: {} });
    expect(prepareNpmCommand("audit", [{ omitDev: true }]).args).toEqual([
      "audit",
      "--json",
      "--omit=dev",
    ]);
    expect(prepareNpmCommand("audit", []).args).toEqual(["audit", "--json"]);
    expect(prepareNpmCommand("outdated", [{ raise: true }])).toEqual({
      args: ["outdated", "--json"],
      options: { raise: true },
    });
    expect(prepareNpmCommand("pack", []).args).toEqual(["pack", "--json", "--dry-run"]);
    expect(prepareNpmCommand("pack", [{ dryRun: false }]).args).toEqual(["pack", "--json"]);
  });

  it("validates special options", () => {
    expect(() => prepareNpmCommand("run", [1])).toThrow("script must be a string");
    expect(() => prepareNpmCommand("test", [{ coverage: "yes" }])).toThrow(
      "options.coverage must be a boolean",
    );
    expect(() => prepareNpmCommand("install", ["pkg"])).toThrow(
      "packages must be an array of strings",
    );
    expect(() => prepareNpmCommand("run", ["check", [], "bad"])).toThrow(
      "options must be an object",
    );
    expect(() => (prepareNpmCommand as any)("unknown", [])).toThrow("Unknown npm method");
  });
});

describe("npm result renderers", () => {
  it("renders scripts, tests, installs, and audit summaries", () => {
    expect(render("run", result("done")).summary).toBe("run, exit 0");
    expect(render("test", result("Tests 12 passed\n")).summary).toBe("test, 12 tests passed");
    expect(render("install", result("added 2 packages\n")).summary).toBe(
      "install, added 2 packages",
    );
    const audit = render(
      "audit",
      result(
        JSON.stringify({ metadata: { vulnerabilities: { total: 3, high: 1, moderate: 2 } } }),
        "",
        1,
      ),
    );
    expect(audit.summary).toBe("audit, 3 vulnerabilities");
    expect(audit.lines.join("\n")).toContain("high: 1");
  });

  it("renders outdated and pack JSON with fallbacks", () => {
    const outdated = render(
      "outdated",
      result(JSON.stringify({ foo: { current: "1", wanted: "2", latest: "3" } }), "", 1),
    );
    expect(outdated.summary).toBe("outdated, 1 package");
    expect(outdated.lines.join("\n")).toContain("foo: 1 → 2 (latest 3)");
    const pack = render(
      "pack",
      result(
        JSON.stringify([
          { name: "pit", version: "0.7.0", filename: "pit.tgz", size: 10, unpackedSize: 20 },
        ]),
      ),
    );
    expect(pack.summary).toBe("pack, pit@0.7.0");
    expect(render("audit", result("bad", "", 1)).summary).toBe("audit, exit 1");
    expect(render("outdated", result("bad", "", 1)).summary).toBe("outdated, exit 1");
    expect(render("pack", result("bad", "", 1)).summary).toBe("pack, exit 1");
  });

  it("covers renderer fallbacks, stderr, and empty output", () => {
    expect(render("run", result()).lines).toContain("(no output)");
    expect(render("run", result("ok", "", 0, true)).summary).toBe("run, exit 0, truncated");
    expect(render("run", result("", "warning")).lines).toContain("stderr");
    expect(render("test", result("no test summary", "", 1)).summary).toBe("test, exit 1");
    expect(render("install", result("custom output")).summary).toBe("install, exit 0");
    expect(render("audit", result(JSON.stringify({ metadata: {} }))).summary).toBe(
      "audit, 0 vulnerabilities",
    );
    const current = render(
      "outdated",
      result(JSON.stringify({ foo: { current: "1", wanted: "2", latest: "2" } })),
    );
    expect(current.lines.join("\n")).not.toContain("latest 2");
    expect(render("pack", result(JSON.stringify([{}]))).summary).toBe("pack, complete");
    const call: CapabilityCall = { capability: "npm", method: "run", qualifiedName: "npm.run" };
    expect(renderResultValue({ bad: true }, theme, call)).toBeUndefined();
    expect(renderResultValue(null, theme, call)).toBeUndefined();
    expect(
      renderResultValue({ stdout: "", stderr: "", code: "bad", truncated: false }, theme, call),
    ).toBeUndefined();
  });
});
