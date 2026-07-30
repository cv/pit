import { describe, expect, it } from "vitest";
import {
  fileRevision,
  lineAnchor,
  lineEnding,
  parseFileLines,
  prepareEdit,
} from "../src/hashline.js";

const anchor = (line: number, content: string) => lineAnchor(line, content);

describe("hashline primitives", () => {
  it("parses stable anchors and line-ending metadata", () => {
    const lf = parseFileLines("one\ntwo\n");
    expect(lf.map((line) => line.anchor)).toEqual([
      anchor(1, "one"),
      anchor(2, "two"),
      anchor(3, ""),
    ]);
    expect(lineEnding(lf)).toBe("lf");
    expect(lineEnding(parseFileLines("one\r\ntwo"))).toBe("crlf");
    expect(lineEnding(parseFileLines("one\r\ntwo\nthree"))).toBe("mixed");
    expect(lineEnding(parseFileLines("one"))).toBe("none");
    expect(fileRevision("value")).toHaveLength(12);
  });

  it("applies anchored replacements, insertions, and deletions", () => {
    const original = "one\ntwo\nthree";
    const revision = fileRevision(original);
    const prepared = prepareEdit(original, {
      revision,
      changes: [
        { kind: "replace", start: anchor(2, "two"), content: "second\ncontinued" },
        { kind: "insertBefore", anchor: anchor(1, "one"), content: "zero" },
        { kind: "insertAfter", anchor: anchor(3, "three"), content: "four" },
      ],
    });
    expect(prepared).toMatchObject({ deleted: false, applied: 3 });
    expect(prepared.next).toBe("zero\none\nsecond\ncontinued\nthree\nfour");

    const insertedWithin = prepareEdit("one\ntwo", {
      revision: fileRevision("one\ntwo"),
      changes: [{ kind: "insertAfter", anchor: anchor(1, "one"), content: "middle" }],
    });
    expect(insertedWithin.next).toBe("one\nmiddle\ntwo");

    const deleted = prepareEdit("one\ntwo\nthree\n", {
      revision: fileRevision("one\ntwo\nthree\n"),
      changes: [{ kind: "delete", start: anchor(2, "two"), end: anchor(3, "three") }],
    });
    expect(deleted.next).toBe("one\n");

    const deleteLast = prepareEdit("one\ntwo", {
      revision: fileRevision("one\ntwo"),
      changes: [{ kind: "delete", start: anchor(2, "two") }],
    });
    expect(deleteLast.next).toBe("one");

    const deleteOnly = prepareEdit("only", {
      revision: fileRevision("only"),
      changes: [{ kind: "delete", start: anchor(1, "only") }],
    });
    expect(deleteOnly.next).toBe("");
  });

  it("normalizes anchored content to the dominant line ending", () => {
    const original = "one\r\ntwo\r\n";
    const prepared = prepareEdit(original, {
      revision: fileRevision(original),
      changes: [{ kind: "replace", start: anchor(2, "two"), content: "second\ncontinued" }],
    });
    expect(prepared.next).toBe("one\r\nsecond\r\ncontinued\r\n");
  });

  it("supports creation, rewriting, and deletion", () => {
    expect(
      prepareEdit(undefined, {
        revision: null,
        changes: [{ kind: "replaceFile", content: "created" }],
      }),
    ).toEqual({ next: "created", deleted: false, applied: 1 });

    const original = "old";
    expect(
      prepareEdit(original, {
        revision: fileRevision(original),
        changes: [{ kind: "replaceFile", content: "new" }],
      }),
    ).toEqual({ next: "new", deleted: false, applied: 1 });
    expect(
      prepareEdit(original, {
        revision: fileRevision(original),
        changes: [{ kind: "deleteFile" }],
      }),
    ).toEqual({ deleted: true, applied: 1 });
  });

  it("rejects stale, malformed, ambiguous, and overlapping edits", () => {
    const original = "one\ntwo\nthree";
    const revision = fileRevision(original);
    expect(() =>
      prepareEdit(original, { revision: "stale", changes: [{ kind: "deleteFile" }] }),
    ).toThrow(/Revision mismatch.*Re-read/);
    expect(() =>
      prepareEdit(original, {
        revision,
        changes: [{ kind: "replace", start: "1:wrong", content: "x" }],
      }),
    ).toThrow(/Anchor mismatch/);
    expect(() =>
      prepareEdit(original, {
        revision,
        changes: [{ kind: "replace", start: "bad", content: "x" }],
      }),
    ).toThrow(/line:hash anchor/);
    expect(() =>
      prepareEdit(original, {
        revision,
        changes: [{ kind: "replace", start: "9:abcde", content: "x" }],
      }),
    ).toThrow(/file has 3 lines/);
    expect(() =>
      prepareEdit(original, {
        revision,
        changes: [
          { kind: "replace", start: anchor(3, "three"), end: anchor(1, "one"), content: "x" },
        ],
      }),
    ).toThrow(/precedes/);
    expect(() =>
      prepareEdit(original, {
        revision,
        changes: [
          { kind: "replace", start: anchor(1, "one"), end: anchor(2, "two"), content: "x" },
          { kind: "insertBefore", anchor: anchor(2, "two"), content: "y" },
        ],
      }),
    ).toThrow(/overlaps/);
    expect(() =>
      prepareEdit(original, {
        revision,
        changes: [
          { kind: "insertBefore", anchor: anchor(2, "two"), content: "y" },
          { kind: "replace", start: anchor(1, "one"), end: anchor(2, "two"), content: "x" },
        ],
      }),
    ).toThrow(/overlaps/);
    expect(() =>
      prepareEdit(original, {
        revision,
        changes: [
          { kind: "replace", start: anchor(1, "one"), end: anchor(2, "two"), content: "x" },
          { kind: "replace", start: anchor(2, "two"), end: anchor(3, "three"), content: "y" },
        ],
      }),
    ).toThrow(/overlaps/);
    expect(() =>
      prepareEdit(original, {
        revision,
        changes: [{ kind: "replaceFile", content: "x" }, { kind: "deleteFile" }],
      }),
    ).toThrow(/file-level changes/);
  });

  it("validates creation and change schemas", () => {
    expect(() =>
      prepareEdit(undefined, {
        revision: "value",
        changes: [{ kind: "replaceFile", content: "x" }],
      }),
    ).toThrow(/revision: null/);
    expect(() =>
      prepareEdit(undefined, { revision: null, changes: [{ kind: "deleteFile" }] }),
    ).toThrow(/exactly one replaceFile/);
    expect(() => prepareEdit("x", null)).toThrow(/changes must be an object/);
    expect(() => prepareEdit("x", { revision: 1, changes: [] })).toThrow(/revision/);
    expect(() =>
      prepareEdit("x", {
        revision: fileRevision("x"),
        changes: [{ kind: "replace", start: 1, content: "x" }],
      }),
    ).toThrow(/start must be a string/);
    expect(() => prepareEdit("x", { revision: fileRevision("x"), changes: [] })).toThrow(
      /non-empty/,
    );
    expect(() =>
      prepareEdit("x", {
        revision: fileRevision("x"),
        changes: [{ kind: "insertAfter", anchor: anchor(1, "x"), content: "" }],
      }),
    ).toThrow(/must not be empty/);
    expect(() =>
      prepareEdit("x", {
        revision: fileRevision("x"),
        changes: [{ kind: "unknown" }],
      }),
    ).toThrow(/Unknown edit change kind/);
  });
});
