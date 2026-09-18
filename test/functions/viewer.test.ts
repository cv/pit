import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FunctionInspector } from "../../src/functions/inspection.js";
import { FunctionViewer } from "../../src/functions/viewer.js";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
beforeEach(() => initTheme("dark"));

describe("function definition viewer", () => {
  it("shows shadowed origins, virtual dependencies, and a valid next target", () => {
    const inspector = new FunctionInspector(
      {
        user: new Map([["calculate", "/** Base. */ async function calculate({}) { return 1; }"]]),
        project: new Map([
          [
            "calculate",
            "/** Decorator. */ async function calculate({ $next, workspace: { read } }) { void read; return $next(); }",
          ],
        ]),
      },
      "/project",
    );
    const viewer = new FunctionViewer(inspector.inspect("calculate", "project"), theme, vi.fn());
    const rendered = viewer.render(300).join("\n");
    expect(rendered).toContain("Dependencies: workspace.read [global]");
    expect(rendered).toContain("$next: calculate [user]");
    expect(rendered).toContain("Transitive effects: workspace.read");
    expect(rendered).toContain("user:");
    const lower = new FunctionViewer(inspector.inspect("calculate", "user"), theme, vi.fn())
      .render(300)
      .join("\n");
    expect(lower).toContain("shadowed; effective: project");
    expect(lower).toContain("Transitive effects: none");
  });

  it("shows a blocked next target and loading diagnostics", () => {
    const inspector = new FunctionInspector(
      {
        invalidUser: new Map([["context.get", "invalid user override"]]),
        project: new Map([["context.get", "async function get({ $next }) { return $next(); }"]]),
      },
      "/project",
    );
    const text = new FunctionViewer(inspector.inspect("context.get", "project"), theme, vi.fn())
      .render(300)
      .join("\n");
    expect(text).toContain("$next: context.get [user] (invalid)");
    expect(text).toContain("user (invalid):");
    expect(text).toContain("Transitive effects: unavailable");
    expect(text).toContain("Unavailable:");
    const missing = new FunctionInspector(
      { session: new Map([["broken", "async function broken({ absent }) { return absent(); }"]]) },
      "/project",
    );
    expect(
      new FunctionViewer(missing.inspect("broken"), theme, vi.fn()).render(300).join("\n"),
    ).toContain("absent [missing]");
  });

  it("bounds metadata lines and ignores non-close keys", () => {
    const definition = new FunctionInspector({}, "/project").inspect("workspace.read");
    definition.documentation = Array.from(
      { length: 120 },
      (_, index) => `documentation ${index}`,
    ).join("\n");
    const close = vi.fn();
    const viewer = new FunctionViewer(definition, theme, close);
    const lines = viewer.render(80);
    expect(lines.join("\n")).toContain("metadata lines omitted");
    expect(lines.length).toBeLessThan(90);
    expect(viewer.render(3).every((line) => visibleWidth(line) <= 3)).toBe(true);
    viewer.handleInput("x");
    expect(close).not.toHaveBeenCalled();
    viewer.handleInput("q");
    expect(close).toHaveBeenCalledOnce();
  });
});
