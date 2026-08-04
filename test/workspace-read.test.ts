import { describe, expect, it } from "vitest";
import { fileRevision, lineAnchor } from "../src/hashline.js";
import { WorkspaceReadScanner } from "../src/workspace-read.js";

const CRLF_SOURCE = "one\r\ntwo\r\n";
const EXPECTED_HASHES = ["one", "two", ""].map(
  (line, index) => lineAnchor(index + 1, line).split(":")[1],
);

function scan(chunks: string[], offset = 1, limit = 2_000, maximum?: number) {
  const scanner = new WorkspaceReadScanner(offset, limit, maximum);
  for (const chunk of chunks) {
    scanner.push(chunk);
  }
  return scanner.finish();
}

describe("WorkspaceReadScanner", () => {
  it.each([
    ["one chunk", [CRLF_SOURCE]],
    ["line chunks", ["one\r\n", "two\r\n"]],
    ["split CRLF", ["one\r", "\ntwo\r", "\n"]],
    ["single-character chunks", [...CRLF_SOURCE]],
  ] as const)("keeps revisions and hashes stable across %s", (_name, chunks) => {
    expect(scan([...chunks])).toEqual({
      selected: CRLF_SOURCE,
      selectedHashes: EXPECTED_HASHES,
      totalLines: 3,
      revision: fileRevision(CRLF_SOURCE),
      selectionTruncated: false,
    });
  });

  it.each([
    ["empty", [], 1, 2_000, "", [lineAnchor(1, "").split(":")[1]], 1],
    ["selected second line", [CRLF_SOURCE], 2, 1, "two\r", [lineAnchor(2, "two").split(":")[1]], 3],
    ["out of range", ["one"], 2, 1, "", [], 1],
    [
      "lone carriage return",
      ["one\r", "two"],
      1,
      1,
      "one\rtwo",
      [lineAnchor(1, "one\rtwo").split(":")[1]],
      1,
    ],
  ] as const)(
    "handles %s selections",
    (_name, chunks, offset, limit, selected, selectedHashes, totalLines) => {
      expect(scan([...chunks], offset, limit)).toMatchObject({
        selected,
        selectedHashes,
        totalLines,
      });
    },
  );

  it("bounds selected content independently from whole-file revision hashing", () => {
    const result = scan(["abcdefghij"], 1, 1, 5);
    expect(result).toMatchObject({
      selected: "abcde",
      revision: fileRevision("abcdefghij"),
      selectionTruncated: true,
    });
  });
});
