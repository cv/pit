import { describe, expect, it } from "vitest";
import { sanitizeTerminalText } from "../src/text-sanitization.js";

describe("terminal text sanitization", () => {
  it("preserves only valid SGR styling when requested", () => {
    const styled =
      "\u001b[31mred\u001b[0m \u001b[38;5;214morange\u001b[39m \u001b[38:2:1:2:3mrgb\u001b[m";
    expect(sanitizeTerminalText(styled)).toBe("red orange rgb");
    expect(sanitizeTerminalText(styled, { preserveSgr: true })).toBe(styled);
  });

  it("strips cursor, screen, OSC, control-string, malformed, and C1 sequences", () => {
    const unsafe = [
      "before",
      "\u001b[2J",
      "clear",
      "\u001b[4;20H",
      "move",
      "\u001b]0;title\u0007",
      "title-safe",
      "\u001b]8;;https://example.test\u001b\\link\u001b]8;;\u001b\\",
      "\u001bPpayload\u001b\\",
      "\u009b2J",
      "after",
      "\u001b[31",
    ].join("");
    expect(sanitizeTerminalText(unsafe, { preserveSgr: true })).toBe(
      "beforeclearmovetitle-safelinkafter",
    );
  });

  it("normalizes line endings and removes ordinary control characters", () => {
    expect(sanitizeTerminalText("one\r\ntwo\rthree\n\tfour\u0000\u007f")).toBe(
      "one\ntwo\nthree\n\tfour",
    );
    expect(sanitizeTerminalText("trailing escape\u001b")).toBe("trailing escape");
    expect(sanitizeTerminalText("reset\u001bcafter")).toBe("resetafter");
  });
});
