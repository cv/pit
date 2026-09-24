import { initTheme } from "@earendil-works/pi-coding-agent";
import { beforeAll, describe, expect, it } from "vitest";

import type { CapabilityCall } from "../../src/renderers/capability.js";
import { renderResultValue } from "../../src/renderers/generic.js";

const theme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => `<bold>${text}</bold>`,
};

beforeAll(() => initTheme("dark"));

function processResult(
  stdout = "",
  stderr = "",
  code = 0,
  truncated = false,
): { stdout: string; stderr: string; code: number; truncated: boolean } {
  return { stdout, stderr, code, truncated };
}

function renderMaybe(method: string, value: unknown) {
  const call: CapabilityCall = {
    capability: "git",
    method,
    qualifiedName: `git.${method}`,
  };
  return renderResultValue(value, theme, call);
}

function render(method: string, value: unknown) {
  const rendered = renderMaybe(method, value);
  if (!rendered) {
    throw new Error(`Expected git.${method} to render`);
  }
  return rendered;
}

describe("Git result renderers", () => {
  it("renders clean and changed porcelain status output", () => {
    const clean = render("status", processResult("## main...origin/main\n"));
    expect(clean).toMatchObject({ kind: "git", summary: "status, main...origin/main, clean" });
    expect(clean.lines.join("\n")).toContain("<accent>## main...origin/main</accent>");

    const changed = render(
      "status",
      processResult(
        "## feature\n M src/index.ts\nA  src/new.ts\nD  old.ts\n?? notes.txt\n   neutral.ts\n",
      ),
    );
    expect(changed.summary).toBe("status, feature, 5 changes");
    const output = changed.lines.join("\n");
    expect(output).toContain("<warning> M</warning>");
    expect(output).toContain("<toolDiffAdded>A </toolDiffAdded>");
    expect(output).toContain("<toolDiffRemoved>D </toolDiffRemoved>");
    expect(output).toContain("<warning>??</warning>");
    expect(output).toContain("   neutral.ts");
  });

  it("falls back gracefully for long-form and failed status output", () => {
    const long = render("status", processResult("On branch main\nnothing to commit\n"));
    expect(long.summary).toBe("status, 2 lines");

    const failed = render("status", processResult("", "not a repository", 128));
    expect(failed.summary).toBe("status, exit 128");
    expect(failed.lines.join("\n")).toContain("<warning>stderr</warning>");
  });

  it("syntax highlights diffs and summarizes empty, failed, and truncated results", () => {
    expect(render("diff", processResult()).summary).toBe("diff, no changes");

    const patch = render(
      "diff",
      processResult("diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n"),
    );
    expect(patch.summary).toBe("diff, 6 lines");
    expect(patch.lines.join("\n")).toContain("diff --git");

    const failed = render("diff", processResult("partial", "bad revision", 1, true));
    expect(failed.summary).toBe("diff, exit 1, truncated");
    expect(failed.lines[0]).toContain("<error>exit 1</error>");
  });

  it("styles compact and full Git history", () => {
    const history = render(
      "log",
      processResult("403cf0d (HEAD -> main) Prepare release\n9ed7a11 feat: add Git capability\n"),
    );
    expect(history.summary).toBe("log, 2 commits");
    expect(history.lines.join("\n")).toContain("<accent>403cf0d</accent>");

    const full = render("log", processResult("commit 403cf0d014486f23\nAuthor: Example\n"));
    expect(full.summary).toBe("log, 1 commit");
    expect(full.lines.join("\n")).toContain("<toolTitle>commit</toolTitle>");

    expect(render("log", processResult("", "bad revision", 128)).summary).toBe("log, exit 128");
  });

  it("renders mutation results compactly", () => {
    const added = render("add", processResult());
    expect(added.summary).toBe("add, complete");
    expect(added.lines).toContain("<dim>(no output)</dim>");

    const committed = render(
      "commit",
      processResult("[main abc1234] Add renderer\n 2 files changed\n"),
    );
    expect(committed.summary).toBe("commit, complete");
    expect(committed.lines.join("\n")).toContain("<success>[main abc1234] Add renderer</success>");

    expect(render("add", processResult("", "pathspec failed", 1)).summary).toBe("add, exit 1");
    expect(render("commit", processResult("", "nothing to commit", 1)).summary).toBe(
      "commit, exit 1",
    );
  });

  it("renders shown patches, JSON objects, plain text, and empty output", () => {
    const patch = render("show", processResult("commit abc1234\ndiff --git a/a b/a\n+line\n"));
    expect(patch.summary).toBe("show, 3 lines");
    expect(patch.lines.join("\n")).toContain("diff --git");

    const json = render("show", processResult('{"name":"pit","version":"0.6.0"}\n'));
    expect(json.summary).toBe("show, 1 line");
    expect(json.lines.join("\n")).toContain('"version": "0.6.0"');

    const plain = render("show", processResult("[incomplete json\nsecond line\n"));
    expect(plain.summary).toBe("show, 2 lines");
    expect(plain.lines).toContain("[incomplete json");

    expect(render("show", processResult()).summary).toBe("show, 0 lines");
    expect(render("show", processResult("", "unknown object", 128)).summary).toBe("show, exit 128");
  });

  it("keeps truncated shown JSON literal even when its retained prefix parses", () => {
    const shown = render("show", processResult('{"line":1}\n', "", 0, true));
    expect(shown.lines).toContain('{"line":1}');
    expect(shown.lines.join("\n")).not.toContain('"line": 1');
  });

  it("treats successful push progress as output and failures as warnings", () => {
    const pushed = render("push", processResult("", "To github.com:cv/pit.git\n   main -> main\n"));
    expect(pushed.summary).toBe("push, complete");
    expect(pushed.lines.join("\n")).toContain("<accent>stderr</accent>");

    const rejected = render("push", processResult("", "rejected", 1));
    expect(rejected.summary).toBe("push, exit 1");
    expect(rejected.lines.join("\n")).toContain("<warning>stderr</warning>");
  });

  it("styles and counts tags", () => {
    const tags = render("tag", processResult("v0.6.0\nv0.5.3\n"));
    expect(render("tag", processResult()).summary).toBe("tag, complete");
    expect(tags.summary).toBe("tag, 2 tags");
    expect(tags.lines.join("\n")).toContain("<accent>v0.6.0</accent>");

    expect(render("tag", processResult("v0.6.0\n")).summary).toBe("tag, 1 tag");
    expect(render("tag", processResult("", "bad pattern", 1)).summary).toBe("tag, exit 1");
  });

  it("declines malformed process values so generic fallback can handle them", () => {
    expect(renderMaybe("status", "clean")).toBeUndefined();
    expect(renderMaybe("status", { stdout: "clean" })).toBeUndefined();
    expect(renderMaybe("status", { ...processResult("clean"), unexpected: true })).toBeUndefined();
  });
});
