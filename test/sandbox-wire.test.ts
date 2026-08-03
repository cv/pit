import { describe, expect, it } from "vitest";
import { WireFrameDecoder } from "../src/sandbox-wire.js";

describe("WireFrameDecoder", () => {
  it("decodes complete and split object frames while ignoring untrusted values", () => {
    const decoder = new WireFrameDecoder(1_000);
    expect(decoder.push('{"type":"result","value":')).toEqual([]);
    expect(decoder.push('42}\nnot-json\nnull\n[]\n{"type":"fatal","error":"boom"}\n')).toEqual([
      { type: "result", value: 42 },
      { type: "fatal", error: "boom" },
    ]);
  });

  it("rejects oversized complete and unterminated frames", () => {
    expect(() => new WireFrameDecoder(4).push("12345")).toThrow("RPC frame exceeds 4 bytes");
    expect(() => new WireFrameDecoder(4).push("12345\n")).toThrow("RPC frame exceeds 4 bytes");
  });
});
