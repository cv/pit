import { describe, expect, it } from "vitest";

import { sanitizeTerminalText } from "../src/text-sanitization.js";

const RESET_WITHOUT_BACKGROUND = "\u001b[10;22;23;24;25;27;28;29;39;50;54;55;59;65;75m";

describe("terminal text sanitization", () => {
  it("preserves only valid SGR styling when requested", () => {
    const styled =
      "\u001b[31mred\u001b[0m \u001b[38;5;214morange\u001b[39m \u001b[38:2:1:2:3mrgb\u001b[m";
    expect(sanitizeTerminalText(styled)).toBe("red orange rgb");
    expect(sanitizeTerminalText(styled, { preserveSgr: true })).toBe(
      `\u001b[31mred${RESET_WITHOUT_BACKGROUND} \u001b[38;5;214morange\u001b[39m \u001b[38:2:1:2:3mrgb${RESET_WITHOUT_BACKGROUND}`,
    );
  });

  it("keeps an enclosing background active across full resets", () => {
    const sanitized = sanitizeTerminalText(
      "\u001b[32mgreen\u001b[0m normal \u001b[mstill inherited \u001b[0;31mred",
      { preserveSgr: true },
    );
    expect(sanitized).toBe(
      `\u001b[32mgreen${RESET_WITHOUT_BACKGROUND} normal ${RESET_WITHOUT_BACKGROUND}still inherited ${RESET_WITHOUT_BACKGROUND}\u001b[31mred`,
    );
    expect(sanitized).not.toContain("\u001b[0m");
    expect(sanitized).not.toContain("\u001b[49m");
  });

  it("fully resets accepted extended text attributes without resetting the background", () => {
    const sanitized = sanitizeTerminalText(
      "\u001b[53moverlined\u001b[0mnormal \u001b[58;2;1;2;3mcolored underline\u001b[mnormal",
      { preserveSgr: true },
    );
    expect(sanitized).toBe(
      `\u001b[53moverlined${RESET_WITHOUT_BACKGROUND}normal \u001b[58;2;1;2;3mcolored underline${RESET_WITHOUT_BACKGROUND}normal`,
    );
    expect(RESET_WITHOUT_BACKGROUND).toContain(";55;");
    expect(RESET_WITHOUT_BACKGROUND).toContain(";59;");
  });

  it("strips output backgrounds while preserving foreground colors and text styles", () => {
    const sanitized = sanitizeTerminalText(
      [
        "\u001b[1;31;41mbasic\u001b[0mnormal",
        " \u001b[100mbright\u001b[49mplain",
        " \u001b[38;5;41;48;5;52mindexed",
        " \u001b[38;2;40;100;47;48;2;4;5;6mrgb",
        " \u001b[38:2:7:8:9;48:2:10:11:12mcolon",
        " \u001b[58;5;41;48;5;52munderline",
      ].join(""),
      { preserveSgr: true },
    );
    expect(sanitized).toBe(
      `\u001b[1;31mbasic${RESET_WITHOUT_BACKGROUND}normal brightplain \u001b[38;5;41mindexed \u001b[38;2;40;100;47mrgb \u001b[38:2:7:8:9mcolon \u001b[58;5;41munderline`,
    );
    expect(sanitized).not.toContain("\u001b[41m");
    expect(sanitized).not.toContain("\u001b[100m");
    expect(sanitized).not.toContain(";48;");
    expect(sanitized).not.toContain(";48:");
    expect(sanitized).not.toContain("\u001b[49m");
  });

  it("drops malformed background forms without leaking their parameters", () => {
    const sanitized = sanitizeTerminalText(
      [
        "\u001b[48msolo",
        " \u001b[48;3;1munknown",
        " \u001b[48;5mshort",
        " \u001b[48;2;;1;2;3;31mred",
        " \u001b[31 minvalid",
      ].join(""),
      { preserveSgr: true },
    );
    expect(sanitized).toBe("solo unknown short \u001b[31mred invalid");
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

  it("strips 8-bit C1 controls and their control-string payloads", () => {
    const unsafe = [
      "before",
      "\u009d0;title\u009c",
      "osc-safe",
      "\u009d1;title\u0007",
      "\u0090dcs-payload\u009c",
      "\u0098sos-payload\u009c",
      "\u009epm-payload\u009c",
      "\u009fapc-payload\u009c",
      "\u0085\u009c",
      "after",
    ].join("");
    expect(sanitizeTerminalText(unsafe, { preserveSgr: true })).toBe("beforeosc-safeafter");
    expect(sanitizeTerminalText("unterminated\u009dtitle", { preserveSgr: true })).toBe(
      "unterminated",
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
