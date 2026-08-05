import { describe, expect, it } from "vitest";

import { HangingIndentText } from "../src/hanging-indent-text.js";

describe("HangingIndentText", () => {
  it("removes inherited prefix styling without stripping content colors", () => {
    const dimPrefix = "\u001b[2m\u001b[90m1:abc|\u001b[39m\u001b[22m";
    const highlightedContent = "\u001b[34mconst\u001b[39m answer = \u001b[33m42\u001b[39m;";
    const component = new HangingIndentText(`${dimPrefix}${highlightedContent}`, { 0: 6 });

    const [rendered] = component.render(80);

    expect(rendered).toContain("\u001b[2m\u001b[90m1:abc|");
    expect(rendered).toContain("\u001b[34mconst\u001b[39m");
    expect(rendered).toContain("\u001b[33m42\u001b[39m");
  });

  it("handles empty, unstyled, wrapped, cached, and invalidated content", () => {
    expect(new HangingIndentText("", {}).render(20)).toEqual([]);

    const component = new HangingIndentText("abalpha beta gamma\nplain", { 0: 2 });
    const first = component.render(8);
    expect(first[0]).toContain("abalpha");
    expect(first[1]?.startsWith("  ")).toBe(true);
    expect(component.render(8)).toBe(first);

    component.invalidate();
    expect(component.render(8)).toEqual(first);
    expect(component.render(2).join("").replace(/\s/g, "")).toContain("plain");
  });
});
