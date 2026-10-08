import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fileRevision, lineAnchor } from "../../src/workspace/hashline.js";
import { handleWorkspace } from "../../src/workspace/host-handler.js";
import { createImageCollector } from "../../src/workspace/view-image.js";
import { cleanupHarness, cwd, run, setupHarness, value } from "../support/extension-fixture.js";

beforeEach(setupHarness);
afterEach(cleanupHarness);

describe("workspace read and edit", () => {
  it("reads hashed content by default and raw content explicitly", async () => {
    await writeFile(join(cwd, "hashed.txt"), "one\r\ntwo\r\n", "utf8");
    const result =
      await value(`async ({ workspace: { batch: workspaceBatch, edit: workspaceEdit, glob: workspaceGlob, list: workspaceList, read: workspaceRead, search: workspaceSearch, stat: workspaceStat } }) => ({
      hashed: await workspaceRead("hashed.txt"),
      raw: await workspaceRead("hashed.txt", { format: "raw" }),
      partial: await workspaceRead("hashed.txt", { offset: 2, limit: 1 }),
    })`);
    expect(result.hashed).toMatchObject({
      file: "hashed.txt",
      format: "hashed",
      revision: fileRevision("one\r\ntwo\r\n"),
      lines: 3,
    });
    expect(result.hashed).not.toHaveProperty("offset");
    expect(result.hashed).not.toHaveProperty("totalLines");
    expect(result.hashed).not.toHaveProperty("hasMore");
    expect(result.hashed).not.toHaveProperty("truncated");
    expect(result.hashed.content).toBe(
      `${lineAnchor(1, "one")}|one\n${lineAnchor(2, "two")}|two\n${lineAnchor(3, "")}|`,
    );
    expect(result.raw).toMatchObject({ format: "raw", content: "one\r\ntwo\r\n", lines: 3 });
    expect(result.raw).not.toHaveProperty("totalLines");
    expect(result.partial).toMatchObject({
      content: `${lineAnchor(2, "two")}|two`,
      offset: 2,
      lines: 1,
      hasMore: true,
    });
  });

  it("bounds large hashed reads and handles empty or out-of-range selections", async () => {
    await writeFile(join(cwd, "large.txt"), "x".repeat(5_000_000), "utf8");
    await writeFile(join(cwd, "empty.txt"), "", "utf8");
    const result =
      await value(`async ({ workspace: { batch: workspaceBatch, edit: workspaceEdit, glob: workspaceGlob, list: workspaceList, read: workspaceRead, search: workspaceSearch, stat: workspaceStat } }) => ({
      large: await workspaceRead("large.txt"),
      empty: await workspaceRead("empty.txt"),
      missingRange: await workspaceRead("empty.txt", { offset: 2 }),
    })`);
    expect(result.large).toMatchObject({ truncated: true, lines: 1 });
    expect(result.large).not.toHaveProperty("totalLines");
    // Hashed reads never show part of a line under a whole-line anchor.
    expect(result.large.content).toBe("");
    expect(result.empty.content).toBe(`${lineAnchor(1, "")}|`);
    expect(result.missingRange.content).toBe("");
  });

  // In #205, a 52,789-byte state file read as 51,200 characters broke JSON.parse, and the
  // program rewrote the file from the fragment.
  it("reads, rewrites, and re-reads a 1 MB JSON state file intact", async () => {
    const ledger = Array.from({ length: 20_000 }, (_, index) => ({
      id: `TX-${index}`,
      from: "ACCT-A",
      to: "ACCT-B",
      amount: index * 7,
    }));
    const text = JSON.stringify(ledger);
    expect(text.length).toBeGreaterThan(1_000_000);
    await writeFile(join(cwd, "ledger.json"), text, "utf8");

    const result = await value(`async ({ workspace: { read, edit } }) => {
      const first = await read("ledger.json", { format: "raw" });
      const entries = JSON.parse(first.content);
      entries.push({ id: "TX-new", from: "ACCT-B", to: "ACCT-A", amount: 1 });
      await edit("ledger.json", {
        revision: first.revision,
        changes: [{ kind: "replaceFile", content: JSON.stringify(entries) }],
      });
      const second = await read("ledger.json", { format: "raw" });
      const reread = JSON.parse(second.content);
      return { count: reread.length, last: reread.at(-1).id, truncated: second.truncated ?? false };
    }`);

    expect(result).toEqual({ count: 20_001, last: "TX-new", truncated: false });
    // The model-visible result stays within Pi's budget; the program held the whole file.
    expect(JSON.parse(await readFile(join(cwd, "ledger.json"), "utf8"))).toHaveLength(20_001);
  });

  it("fails a raw read larger than the program-data budget unless it selects a part", async () => {
    await writeFile(join(cwd, "huge.txt"), "x\n".repeat(2_500_000), "utf8");
    const result = await value(`async ({ workspace: { read } }) => {
      let whole;
      try { await read("huge.txt", { format: "raw" }); whole = "read"; } catch (error) { whole = error.message; }
      const part = await read("huge.txt", { format: "raw", offset: 1_000, limit: 3 });
      return { whole, part };
    }`);
    expect(result.whole).toBe(
      "Cannot read huge.txt raw: the selection is larger than 4,000,000 bytes (the file has 2,500,001 lines). Pass offset and limit to read it in parts.",
    );
    expect(result.part).toMatchObject({
      content: "x\nx\nx",
      offset: 1_000,
      lines: 3,
      hasMore: true,
    });
    expect(result.part).not.toHaveProperty("truncated");
  });

  it("validates read arguments and supports @-prefixed paths", async () => {
    await writeFile(join(cwd, "at.txt"), "contents", "utf8");
    expect(
      await value(
        `async ({ workspace: { batch: workspaceBatch, edit: workspaceEdit, glob: workspaceGlob, list: workspaceList, read: workspaceRead, search: workspaceSearch, stat: workspaceStat } }) => workspaceRead("@at.txt", { format: "raw" })`,
      ),
    ).toMatchObject({
      content: "contents",
    });
    const errors =
      await value(`async ({ workspace: { batch: workspaceBatch, edit: workspaceEdit, glob: workspaceGlob, list: workspaceList, read: workspaceRead, search: workspaceSearch, stat: workspaceStat } }) => {
      const raw = { batch: workspaceBatch, read: workspaceRead, search: workspaceSearch } as any;
      const capture = async (options) => { try { await raw.read("at.txt", options); return "ok"; } catch (error) { return error.message; } };
      return [
        await capture({ format: "lines" }),
        await capture({ offset: 0 }),
        await capture({ offset: 1.5 }),
        await capture({ limit: 0 }),
        await capture("bad"),
      ];
    }`);
    expect(errors[0]).toContain('format must be "hashed" or "raw"');
    expect(errors.slice(1, 4).join("\n")).toMatch(/positive integers/);
    expect(errors[4]).toContain("options must be an object");
  });

  // #252: elide names these files and revisions when it stubs the call that changed them.
  it("records the edits a program applied in its result details", async () => {
    await writeFile(join(cwd, "kept.txt"), "kept", "utf8");
    const result = await run(`async ({ workspace: { batch, edit } }) => {
      await edit("a.txt", { revision: null, changes: [{ kind: "replaceFile", content: "a" }] });
      await batch([
        { kind: "edit", file: "b.txt", changes: { revision: null, changes: [{ kind: "replaceFile", content: "b" }] } },
      ]);
      await batch([{ kind: "read", file: "kept.txt" }]);
      await edit("c.txt", { revision: null, changes: [{ kind: "replaceFile", content: "c" }] });
      await edit("a.txt", { revision: ${JSON.stringify(fileRevision("a"))}, changes: [{ kind: "deleteFile" }] });
      return "done";
    }`);
    expect(result.details.edits).toEqual([
      { file: "a.txt", revision: fileRevision("a"), applied: 1 },
      { file: "b.txt", revision: fileRevision("b"), applied: 1 },
      { file: "c.txt", revision: fileRevision("c"), applied: 1 },
      { file: "a.txt", revision: null, applied: 1, deleted: true },
    ]);

    const reads = await run(`async ({ workspace: { read } }) => read("kept.txt")`);
    expect(reads.details).not.toHaveProperty("edits");
  });

  it("keeps up to 32 applied edits, even after the journal evicts their calls", async () => {
    const result = await run(`async ({ workspace: { edit, stat } }) => {
      for (let index = 0; index < 34; index++) {
        await edit("f" + index + ".txt", { revision: null, changes: [{ kind: "replaceFile", content: "x" }] });
      }
      // More calls than the journal keeps.
      for (let index = 0; index < 130; index++) await stat("f0.txt");
      return "done";
    }`);
    expect(result.details.edits).toHaveLength(32);
    expect(result.details.edits.at(-1)).toMatchObject({ file: "f31.txt", applied: 1 });
    expect(result.details.editsOmitted).toBe(2);
  });

  // #253: one call reads the parts of a file an edit needs, with one revision.
  it.each([
    { name: "LF", separator: "\n" },
    { name: "CRLF", separator: "\r\n" },
  ])(
    "reads merged line ranges that match whole reads and anchor an edit ($name)",
    async ({ separator }) => {
      const original = Array.from({ length: 30 }, (_, index) => `line${index + 1}`).join(separator);
      await writeFile(join(cwd, "parts.txt"), original, "utf8");
      const result = await value(`async ({ workspace: { edit, read } }) => {
      const parts = await read("parts.txt", { ranges: [[20, 22], [3, 4], [5, 6], [28, 40]] });
      const whole = await read("parts.txt");
      const reads = await Promise.all(
        parts.ranges.map((range) => read("parts.txt", { offset: range.start, limit: range.end - range.start + 1 })),
      );
      const anchor = parts.ranges[1]!.content.split("\\n")[0]!.split("|")[0] as \`\${number}:\${string}\`;
      const edited = await edit("parts.txt", { revision: parts.revision, changes: [{ kind: "replace", start: anchor, content: "twenty" }] });
      return { parts, wholeRevision: whole.revision, reads: reads.map((read) => read.content), applied: edited.applied };
    }`);
      // [3, 4] and [5, 6] touch, so they merge; [28, 40] stops at the last line.
      expect(
        result.parts.ranges.map(({ start, end }: { start: number; end: number }) => [start, end]),
      ).toEqual([
        [3, 6],
        [20, 22],
        [28, 30],
      ]);
      expect(result.parts.ranges.map(({ content }: { content: string }) => content)).toEqual(
        result.reads,
      );
      expect(result.parts).toMatchObject({
        revision: result.wholeRevision,
        lines: 10,
        totalLines: 30,
      });
      expect(result.parts).not.toHaveProperty("truncated");
      expect(result.applied).toBe(1);
    },
  );

  it("bounds range reads by a read's line and byte budgets and rejects invalid ranges", async () => {
    await writeFile(
      join(cwd, "many.txt"),
      Array.from({ length: 3000 }, (_, index) => `row${index + 1}`).join("\n"),
      "utf8",
    );
    await writeFile(
      join(cwd, "wide.txt"),
      Array.from({ length: 5 }, () => "x".repeat(20_000)).join("\n"),
      "utf8",
    );
    const result = await value(`async ({ workspace: { read } }) => {
      const rejected = (options: unknown) =>
        read("many.txt", options as never).then(() => "accepted", (error: Error) => error.message);
      return {
        many: await read("many.txt", { ranges: [[1, 1500], [2000, 3000]] }),
        wide: await read("wide.txt", { ranges: [[1, 2], [4, 5]] }),
        errors: await Promise.all([
          rejected({ ranges: [[1, 2]], offset: 3 }),
          rejected({ ranges: [[1, 2]], format: "raw" }),
          rejected({ ranges: [[0, 2]] }),
          rejected({ ranges: [[5, 3]] }),
          rejected({ ranges: [[1]] }),
          rejected({ ranges: [] }),
          rejected({ ranges: Array.from({ length: 21 }, (_, index) => [index + 1, index + 1]) }),
          rejected({ ranges: [[1, 2], [3001, 3005]] }),
        ]),
      };
    }`);
    const spans = (read: { ranges: Array<{ start: number; end: number }> }) =>
      read.ranges.map(({ start, end }) => [start, end]);
    // The 2,000-line budget is shared: 1,500 lines, then 500 of the second range.
    expect(spans(result.many)).toEqual([
      [1, 1500],
      [2000, 2499],
    ]);
    expect(result.many.truncated).toBe(true);
    // Two 20,000-character lines fit in 50 KB; the next whole line does not.
    expect(spans(result.wide)).toEqual([[1, 2]]);
    expect(result.wide.truncated).toBe(true);
    expect(result.errors).toEqual([
      "options.ranges cannot be combined with offset or limit",
      "options.ranges requires the hashed format",
      "options.ranges[0] must be [start, end] line numbers with 1 <= start <= end",
      "options.ranges[0] must be [start, end] line numbers with 1 <= start <= end",
      "options.ranges[0] must be [start, end] line numbers with 1 <= start <= end",
      "options.ranges must be 1-20 [start, end] line pairs",
      "options.ranges must be 1-20 [start, end] line pairs",
      "A range starts at line 3001, but many.txt has 3000 lines",
    ]);
  });

  // #251: 71 of 141 rereads in session 01a0f528 came right after the agent's own edit.
  it.each([
    { name: "LF", separator: "\n" },
    { name: "CRLF", separator: "\r\n" },
  ])(
    "returns ranges that match a read and anchor a follow-up edit ($name)",
    async ({ separator }) => {
      const original = Array.from({ length: 30 }, (_, index) => `line${index + 1}`).join(separator);
      await writeFile(join(cwd, "ranges.txt"), original, "utf8");
      const result = await value(`async ({ workspace: { edit, read } }) => {
        const before = await read("ranges.txt");
        const anchor = (line: number) => before.content.split("\\n")[line - 1]!.split("|")[0] as \`\${number}:\${string}\`;
        const edited = await edit("ranges.txt", {
          revision: before.revision,
          context: 1,
          changes: [
            { kind: "replace", start: anchor(5), content: "five-a\\nfive-b" },
            { kind: "replace", start: anchor(8), content: "eight" },
            { kind: "insertAfter", anchor: anchor(20), content: "twenty-x" },
            { kind: "delete", start: anchor(25) },
          ],
        });
        const ranges = edited.ranges ?? [];
        const reads = await Promise.all(
          ranges.map((range) => read("ranges.txt", { offset: range.start, limit: range.end - range.start + 1 })),
        );
        const stale = await edit("ranges.txt", {
          revision: edited.revision,
          changes: [{ kind: "replace", start: anchor(21), content: "x" }],
        }).then(() => "accepted", (error: Error) => error.message);
        const fresh = ranges[1]!.content.split("\\n")[0]!.split("|")[0] as \`\${number}:\${string}\`;
        const followUp = await edit("ranges.txt", {
          revision: edited.revision ?? "",
          changes: [{ kind: "replace", start: fresh, content: "twenty-one" }],
        });
        return { edited, reads: reads.map((read) => read.content), stale, followUp: followUp.applied };
      }`);
      // The replaced line 5 is now lines 5-6, and old line 8 is line 9, so their windows merge.
      // The insertion after old line 20 is line 22, and the deleted old line 25 leaves old line
      // 26 at line 27.
      expect(
        result.edited.ranges.map(({ start, end }: { start: number; end: number }) => [start, end]),
      ).toEqual([
        [4, 10],
        [21, 23],
        [26, 28],
      ]);
      expect(result.edited.ranges.map(({ content }: { content: string }) => content)).toEqual(
        result.reads,
      );
      expect(result.edited).not.toHaveProperty("rangesTruncated");
      expect(result.stale).toMatch(/^Anchor mismatch at line 21/);
      expect(result.followUp).toBe(1);
    },
  );

  it("bounds returned ranges per edit and per batch", async () => {
    const content = Array.from({ length: 300 }, (_, index) => `row${index}`).join("\n");
    const result = await value(`async ({ workspace: { batch, edit } }) => {
      const content = ${JSON.stringify(content)};
      const single = await edit("one.txt", { revision: null, context: 0, changes: [{ kind: "replaceFile", content }] });
      const many = await batch([
        { kind: "edit", file: "a.txt", changes: { revision: null, context: 0, changes: [{ kind: "replaceFile", content }] } },
        { kind: "edit", file: "b.txt", changes: { revision: null, context: 0, changes: [{ kind: "replaceFile", content }] } },
        { kind: "edit", file: "c.txt", changes: { revision: null, context: 0, changes: [{ kind: "replaceFile", content }] } },
      ]);
      const long = await edit("long.txt", { revision: null, context: 0, changes: [{ kind: "replaceFile", content: "x".repeat(40000) }] });
      const plain = await edit("plain.txt", { revision: null, changes: [{ kind: "replaceFile", content }] });
      const invalid = await edit("bad.txt", { revision: null, context: 21, changes: [{ kind: "replaceFile", content }] })
        .then(() => "accepted", (error: Error) => error.message);
      return { single, many: many.results.map((item) => item.value), long, plain, invalid };
    }`);
    const spans = (edit: {
      ranges?: Array<{ start: number; end: number }>;
      rangesTruncated?: true;
    }) => [
      (edit.ranges ?? []).map(({ start, end }) => [start, end]),
      edit.rangesTruncated ?? false,
    ];
    expect(spans(result.single)).toEqual([[[1, 200]], true]);
    // The batch shares one 400-line budget.
    expect(result.many.map(spans)).toEqual([
      [[[1, 300]], false],
      [[[1, 100]], true],
      [[], true],
    ]);
    expect(spans(result.long)).toEqual([[], true]);
    expect(result.plain).not.toHaveProperty("ranges");
    expect(result.invalid).toBe("changes.context must be an integer from 0 to 20");
  });

  it("creates, anchors, rewrites, and deletes through one edit method", async () => {
    const original = "one\ntwo\nthree";
    const created =
      await value(`async ({ workspace: { batch: workspaceBatch, edit: workspaceEdit, glob: workspaceGlob, list: workspaceList, read: workspaceRead, search: workspaceSearch, stat: workspaceStat } }) => workspaceEdit("single-edit.txt", {
      revision: null,
      changes: [{ kind: "replaceFile", content: ${JSON.stringify(original)} }],
    })`);
    expect(created).toMatchObject({ file: "single-edit.txt", applied: 1, deleted: false });

    const next = "one\nsecond\nthree\nfour";
    const anchored =
      await value(`async ({ workspace: { batch: workspaceBatch, edit: workspaceEdit, glob: workspaceGlob, list: workspaceList, read: workspaceRead, search: workspaceSearch, stat: workspaceStat } }) => workspaceEdit("single-edit.txt", {
      revision: ${JSON.stringify(fileRevision(original))},
      changes: [
        { kind: "replace", start: ${JSON.stringify(lineAnchor(2, "two"))}, content: "second" },
        { kind: "insertAfter", anchor: ${JSON.stringify(lineAnchor(3, "three"))}, content: "four" },
      ],
    })`);
    expect(await readFile(join(cwd, "single-edit.txt"), "utf8")).toBe(next);
    expect(anchored.revision).toBe(fileRevision(next));

    const rewritten =
      await value(`async ({ workspace: { batch: workspaceBatch, edit: workspaceEdit, glob: workspaceGlob, list: workspaceList, read: workspaceRead, search: workspaceSearch, stat: workspaceStat } }) => workspaceEdit("single-edit.txt", {
      revision: ${JSON.stringify(fileRevision(next))},
      changes: [{ kind: "replaceFile", content: "rewritten" }],
    })`);
    expect(rewritten.revision).toBe(fileRevision("rewritten"));

    await expect(
      run(`async ({ workspace: { batch: workspaceBatch, edit: workspaceEdit, glob: workspaceGlob, list: workspaceList, read: workspaceRead, search: workspaceSearch, stat: workspaceStat } }) => workspaceEdit("single-edit.txt", {
        revision: ${JSON.stringify(fileRevision(next))}, changes: [{ kind: "deleteFile" }],
      })`),
    ).rejects.toThrow(/Revision mismatch/);

    const deleted =
      await value(`async ({ workspace: { batch: workspaceBatch, edit: workspaceEdit, glob: workspaceGlob, list: workspaceList, read: workspaceRead, search: workspaceSearch, stat: workspaceStat } }) => workspaceEdit("single-edit.txt", {
      revision: ${JSON.stringify(fileRevision("rewritten"))}, changes: [{ kind: "deleteFile" }],
    })`);
    expect(deleted).toMatchObject({ revision: null, deleted: true, bytes: 0 });
    await expect(readFile(join(cwd, "single-edit.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("returns relative edit paths and cooperates with cancellation", async () => {
    const outsideName = `outside-${basename(cwd)}.txt`;
    const outside = join(cwd, "..", outsideName);
    try {
      const result =
        await value(`async ({ workspace: { batch: workspaceBatch, edit: workspaceEdit, glob: workspaceGlob, list: workspaceList, read: workspaceRead, search: workspaceSearch, stat: workspaceStat } }) => workspaceEdit(${JSON.stringify(outside)}, {
        revision: null, changes: [{ kind: "replaceFile", content: "outside" }],
      })`);
      expect(result.file).toBe(`../${outsideName}`);
    } finally {
      await unlink(outside).catch(() => undefined);
    }

    const controller = new AbortController();
    controller.abort();
    await expect(
      handleWorkspace(
        { cwd, images: createImageCollector({ cwd } as any) },
        "edit",
        ["cancelled.txt", { revision: null, changes: [{ kind: "replaceFile", content: "late" }] }],
        controller.signal,
      ),
    ).rejects.toThrow();
    await expect(readFile(join(cwd, "cancelled.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("workspace batch", () => {
  it("runs concurrent reads with settled and fail-fast modes", async () => {
    await writeFile(join(cwd, "present.txt"), "present", "utf8");
    const settled =
      await value(`async ({ workspace: { batch: workspaceBatch, edit: workspaceEdit, glob: workspaceGlob, list: workspaceList, read: workspaceRead, search: workspaceSearch, stat: workspaceStat } }) => {
      const batch = await workspaceBatch([
        { kind: "read", file: "present.txt", options: { format: "raw" } },
        { kind: "read", file: "missing.txt" },
      ], { failure: "settled" });
      batch.results.map((entry) => entry.value);
      return batch;
    }`);
    expect(settled.results[0]).toMatchObject({ kind: "read", index: 0, ok: true });
    expect(settled.results[0].value.content).toBe("present");
    expect(settled.results[1]).toMatchObject({ kind: "read", index: 1, ok: false });
    expect(settled.results[1].error).toContain("ENOENT");

    await expect(
      run(`async ({ workspace: { batch: workspaceBatch, edit: workspaceEdit, glob: workspaceGlob, list: workspaceList, read: workspaceRead, search: workspaceSearch, stat: workspaceStat } }) => workspaceBatch([
        { kind: "read", file: "present.txt" }, { kind: "read", file: "missing.txt" },
      ])`),
    ).rejects.toThrow(/ENOENT/);
  });

  it("commits all-edit batches transactionally", async () => {
    const first = "first";
    await writeFile(join(cwd, "delete.txt"), "delete", "utf8");
    await writeFile(join(cwd, "first.txt"), first, "utf8");
    const result =
      await value(`async ({ workspace: { batch: workspaceBatch, edit: workspaceEdit, glob: workspaceGlob, list: workspaceList, read: workspaceRead, search: workspaceSearch, stat: workspaceStat } }) => workspaceBatch([
      {
        kind: "edit", file: "first.txt",
        changes: {
          revision: ${JSON.stringify(fileRevision(first))},
          changes: [{ kind: "replace", start: ${JSON.stringify(lineAnchor(1, first))}, content: "changed" }],
        },
      },
      {
        kind: "edit", file: "created.txt",
        changes: { revision: null, changes: [{ kind: "replaceFile", content: "created" }] },
      },
      {
        kind: "edit", file: "delete.txt",
        changes: { revision: ${JSON.stringify(fileRevision("delete"))}, changes: [{ kind: "deleteFile" }] },
      },
    ])`);
    expect(result.results).toEqual([
      {
        kind: "edit",
        index: 0,
        ok: true,
        value: expect.objectContaining({ file: "first.txt", applied: 1, deleted: false }),
      },
      {
        kind: "edit",
        index: 1,
        ok: true,
        value: expect.objectContaining({ file: "created.txt", applied: 1, deleted: false }),
      },
      {
        kind: "edit",
        index: 2,
        ok: true,
        value: expect.objectContaining({
          file: "delete.txt",
          applied: 1,
          deleted: true,
          revision: null,
        }),
      },
    ]);
    expect(await readFile(join(cwd, "first.txt"), "utf8")).toBe("changed");
    expect(await readFile(join(cwd, "created.txt"), "utf8")).toBe("created");
    await expect(readFile(join(cwd, "delete.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("validates every edit before committing and rolls back write failures", async () => {
    await writeFile(join(cwd, "a.txt"), "a", "utf8");
    await writeFile(join(cwd, "b.txt"), "b", "utf8");
    await expect(
      run(`async ({ workspace: { batch: workspaceBatch, edit: workspaceEdit, glob: workspaceGlob, list: workspaceList, read: workspaceRead, search: workspaceSearch, stat: workspaceStat } }) => workspaceBatch([
        {
          kind: "edit", file: "a.txt",
          changes: { revision: ${JSON.stringify(fileRevision("a"))}, changes: [{ kind: "replaceFile", content: "changed" }] },
        },
        {
          kind: "edit", file: "b.txt",
          changes: { revision: "stale", changes: [{ kind: "replaceFile", content: "never" }] },
        },
      ])`),
    ).rejects.toThrow(/Revision mismatch/);
    expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("a");

    await writeFile(join(cwd, "z-parent"), "not a directory", "utf8");
    await expect(
      run(`async ({ workspace: { batch: workspaceBatch, edit: workspaceEdit, glob: workspaceGlob, list: workspaceList, read: workspaceRead, search: workspaceSearch, stat: workspaceStat } }) => workspaceBatch([
        {
          kind: "edit", file: "a.txt",
          changes: { revision: ${JSON.stringify(fileRevision("a"))}, changes: [{ kind: "replaceFile", content: "temporary" }] },
        },
        {
          kind: "edit", file: "z-parent/child.txt",
          changes: { revision: null, changes: [{ kind: "replaceFile", content: "fails" }] },
        },
      ])`),
    ).rejects.toThrow();
    expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("a");

    await expect(
      run(`async ({ workspace: { batch: workspaceBatch, edit: workspaceEdit, glob: workspaceGlob, list: workspaceList, read: workspaceRead, search: workspaceSearch, stat: workspaceStat } }) => workspaceBatch([
        {
          kind: "edit", file: "temporary.txt",
          changes: { revision: null, changes: [{ kind: "replaceFile", content: "temporary" }] },
        },
        {
          kind: "edit", file: "z-parent/child.txt",
          changes: { revision: null, changes: [{ kind: "replaceFile", content: "fails" }] },
        },
      ])`),
    ).rejects.toThrow();
    await expect(readFile(join(cwd, "temporary.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("validates batch shapes, modes, and unique edit files", async () => {
    const errors =
      await value(`async ({ workspace: { batch: workspaceBatch, edit: workspaceEdit, glob: workspaceGlob, list: workspaceList, read: workspaceRead, search: workspaceSearch, stat: workspaceStat } }) => {
      const raw = { batch: workspaceBatch, read: workspaceRead, search: workspaceSearch } as any;
      const capture = async (operations, options?) => { try { await (options === undefined ? raw.batch(operations) : raw.batch(operations, options)); return "ok"; } catch (error) { return error.message; } };
      return [
        await capture([]),
        await capture("bad"),
        await capture([null]),
        await capture([{ kind: "unknown" }]),
        await capture([{ kind: "read", file: "a" }, { kind: "edit", file: "b", changes: {} }]),
        await capture([{ kind: "read", file: "a" }], { failure: "later" }),
        await capture([{ kind: "edit", file: "a", changes: {} }], { failure: "settled" }),
        await capture([
          { kind: "edit", file: "same", changes: {} },
          { kind: "edit", file: "same", changes: {} },
        ]),
      ];
    }`);
    expect(errors[0]).toContain("non-empty array");
    expect(errors[1]).toContain("non-empty array");
    expect(errors[2]).toContain("must be an object");
    expect(errors[3]).toContain("Unknown batch operation");
    expect(errors[4]).toContain("cannot mix read and edit");
    expect(errors[5]).toContain('failure must be "fail-fast" or "settled"');
    expect(errors[6]).toContain("only supported for read");
    expect(errors[7]).toContain("unique files");
  });
});

describe("workspace discovery", () => {
  it("lists, globs, and stats files", async () => {
    await writeFile(join(cwd, "existing.txt"), "one", "utf8");
    await writeFile(join(cwd, "second.txt"), "two", "utf8");
    await symlink(join(cwd, "existing.txt"), join(cwd, "link.txt"));
    await mkdir(join(cwd, "nested"));
    await mkdir(join(cwd, "folder"));
    await writeFile(join(cwd, "folder", "inside.txt"), "three", "utf8");
    const result =
      await value(`async ({ workspace: { batch: workspaceBatch, edit: workspaceEdit, glob: workspaceGlob, list: workspaceList, read: workspaceRead, search: workspaceSearch, stat: workspaceStat } }) => ({
      list: await workspaceList(),
      nestedList: await workspaceList("nested"),
      glob: await workspaceGlob("**/*.txt", { onlyFiles: true, limit: 1 }),
      defaultGlob: await workspaceGlob(),
      filteredGlob: await workspaceGlob(["**/*.txt"], { ignore: ["second.txt"] }),
      directoryGlob: await workspaceGlob("folder"),
      stat: await workspaceStat("existing.txt"),
    })`);
    expect(result.list).toEqual(
      expect.arrayContaining([
        { name: "existing.txt", type: "file" },
        { name: "link.txt", type: "symlink" },
        { name: "nested", type: "directory" },
      ]),
    );
    expect(result.nestedList).toEqual([]);
    expect(result.glob).toMatchObject({ entries: ["existing.txt"], truncated: true });
    expect(result.defaultGlob.entries).toEqual(expect.arrayContaining(["existing.txt", "nested"]));
    expect(result.filteredGlob.entries).not.toContain("second.txt");
    expect(result.directoryGlob).toEqual({ entries: ["folder"], truncated: false });
    expect(result.stat).toMatchObject({ size: 3, file: true, directory: false });
  });

  it("validates glob limits", async () => {
    const errors =
      await value(`async ({ workspace: { batch: workspaceBatch, edit: workspaceEdit, glob: workspaceGlob, list: workspaceList, read: workspaceRead, search: workspaceSearch, stat: workspaceStat } }) => {
      const capture = async (limit) => { try { await workspaceGlob("*", { limit }); return "ok"; } catch (error) { return error.message; } };
      return [await capture(0), await capture(10001)];
    }`);
    expect(errors.join("\n")).toContain("integer between 1 and 10000");
  });
});

describe("workspace search", () => {
  // A literal query that uses regex syntax almost always meant regex: true.
  it("hints when a literal query with regex syntax finds nothing", async () => {
    await mkdir(join(cwd, "hint"));
    await writeFile(join(cwd, "hint/a.txt"), "alpha\nbeta\n", "utf8");
    const search = (query: string, regex: boolean) =>
      value(
        `async ({ workspace: { search: workspaceSearch } }) => workspaceSearch(${JSON.stringify(query)}, { path: "hint", regex: ${regex} })`,
      );
    const literal = await search("alpha|beta", false);
    expect(literal.matches).toEqual([]);
    expect(literal.hint).toContain('("|")');
    expect(literal.hint).toContain("regex: true");
    const pattern = await search("alpha|beta", true);
    expect(pattern.matches.map((match: { line: number }) => match.line)).toEqual([1, 2]);
    expect(pattern).not.toHaveProperty("hint");
    expect(await search("gamma", false)).not.toHaveProperty("hint");
  });

  it("returns edit-ready anchors, revisions, and bounded context", async () => {
    await mkdir(join(cwd, "search"));
    await writeFile(join(cwd, "search/a.txt"), "Alpha\nneedle one\nNEEDLE two\nend", "utf8");
    await writeFile(join(cwd, "search/b.txt"), "nothing here", "utf8");
    await writeFile(join(cwd, "search/binary.bin"), Buffer.from([0, 1, 2]));
    await writeFile(join(cwd, "search/huge.txt"), "x".repeat(1_000_001), "utf8");
    await writeFile(join(cwd, "search/unreadable.txt"), "needle", "utf8");
    await chmod(join(cwd, "search/unreadable.txt"), 0o000);

    const result =
      await value(`async ({ workspace: { batch: workspaceBatch, edit: workspaceEdit, glob: workspaceGlob, list: workspaceList, read: workspaceRead, search: workspaceSearch, stat: workspaceStat } }) => workspaceSearch("needle", {
      path: "search", glob: "**/*", caseSensitive: false, contextLines: 1, limit: 10,
    })`);
    expect(result.matches).toEqual([
      {
        file: "search/a.txt",
        revision: fileRevision("Alpha\nneedle one\nNEEDLE two\nend"),
        line: 2,
        anchor: lineAnchor(2, "needle one"),
        column: 1,
        text: "needle one",
        before: [{ line: 1, anchor: lineAnchor(1, "Alpha"), text: "Alpha" }],
        after: [{ line: 3, anchor: lineAnchor(3, "NEEDLE two"), text: "NEEDLE two" }],
      },
      expect.objectContaining({ line: 3, anchor: lineAnchor(3, "NEEDLE two") }),
    ]);
    expect(result).toMatchObject({ truncated: false, filesSearched: 2, filesSkipped: 3 });
    await chmod(join(cwd, "search/unreadable.txt"), 0o600);
    await writeFile(join(cwd, "search/crlf.txt"), "Needle\r\nother", "utf8");
    const filtered =
      await value(`async ({ workspace: { batch: workspaceBatch, edit: workspaceEdit, glob: workspaceGlob, list: workspaceList, read: workspaceRead, search: workspaceSearch, stat: workspaceStat } }) => workspaceSearch("Needle", {
      glob: ["search/*.txt"], ignore: ["**/b.txt"], dot: true,
    })`);
    expect(filtered.matches[0]).toMatchObject({
      file: "search/crlf.txt",
      text: "Needle",
      anchor: lineAnchor(1, "Needle"),
    });

    const regex =
      await value(`async ({ workspace: { batch: workspaceBatch, edit: workspaceEdit, glob: workspaceGlob, list: workspaceList, read: workspaceRead, search: workspaceSearch, stat: workspaceStat } }) => workspaceSearch("^n.*e", {
      path: "search/a.txt", regex: true, caseSensitive: false, limit: 1,
    })`);
    expect(regex.matches[0]).toMatchObject({ line: 2, anchor: lineAnchor(2, "needle one") });
    expect(regex.truncated).toBe(true);

    const zeroLength =
      await value(`async ({ workspace: { batch: workspaceBatch, edit: workspaceEdit, glob: workspaceGlob, list: workspaceList, read: workspaceRead, search: workspaceSearch, stat: workspaceStat } }) => workspaceSearch("^", {
      path: "search/a.txt", regex: true, limit: 10,
    })`);
    expect(zeroLength.matches).toHaveLength(4);

    const defaults = await value(
      `async ({ workspace: { batch: workspaceBatch, edit: workspaceEdit, glob: workspaceGlob, list: workspaceList, read: workspaceRead, search: workspaceSearch, stat: workspaceStat } }) => workspaceSearch("Alpha")`,
    );
    expect(defaults.matches[0]).toMatchObject({ file: "search/a.txt", line: 1 });
  });

  it("interrupts pathological regexes and validates search options", async () => {
    await writeFile(join(cwd, "regex.txt"), `${"a".repeat(30_000)}!`, "utf8");
    await expect(
      run(
        `async ({ workspace: { batch: workspaceBatch, edit: workspaceEdit, glob: workspaceGlob, list: workspaceList, read: workspaceRead, search: workspaceSearch, stat: workspaceStat } }) => workspaceSearch("^(a+)+$", { path: "regex.txt", regex: true })`,
      ),
    ).rejects.toThrow(/Regex search exceeded 250ms/);

    execFileSync("mkfifo", [join(cwd, "search-pipe")]);
    const errors =
      await value(`async ({ workspace: { batch: workspaceBatch, edit: workspaceEdit, glob: workspaceGlob, list: workspaceList, read: workspaceRead, search: workspaceSearch, stat: workspaceStat } }) => {
      const raw = { batch: workspaceBatch, read: workspaceRead, search: workspaceSearch } as any;
      const capture = async (query, options) => { try { await raw.search(query, options); return "ok"; } catch (error) { return error.message; } };
      return [
        await capture("", {}),
        await capture("x", { contextLines: 11 }),
        await capture("x", { limit: 0 }),
        await capture("[", { regex: true }),
        await capture(42, {}),
        await capture("x", "bad"),
        await capture("x", { path: "search-pipe" }),
      ];
    }`);
    expect(errors[0]).toContain("must not be empty");
    expect(errors[1]).toContain("contextLines");
    expect(errors[2]).toContain("limit");
    expect(errors[3]).toContain("Invalid search regex");
    expect(errors[4]).toContain("query must be a string");
    expect(errors[5]).toContain("options must be an object");
    expect(errors[6]).toContain("search path must be a file or directory");
  });
});
