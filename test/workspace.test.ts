import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileRevision, lineAnchor } from "../src/hashline.js";
import { handleWorkspace } from "../src/workspace.js";
import { cleanupHarness, cwd, run, setupHarness, value } from "./extension-fixture.js";

beforeEach(setupHarness);
afterEach(cleanupHarness);

describe("workspace read and edit", () => {
  it("reads hashed content by default and raw content explicitly", async () => {
    await writeFile(join(cwd, "hashed.txt"), "one\r\ntwo\r\n", "utf8");
    const result = await value(`async ({ workspace }) => ({
      hashed: await workspace.read("hashed.txt"),
      raw: await workspace.read("hashed.txt", { format: "raw" }),
      partial: await workspace.read("hashed.txt", { offset: 2, limit: 1 }),
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

  it("bounds large reads and handles empty or out-of-range selections", async () => {
    await writeFile(join(cwd, "large.txt"), "x".repeat(5_000_000), "utf8");
    await writeFile(join(cwd, "empty.txt"), "", "utf8");
    const result = await value(`async ({ workspace }) => ({
      large: await workspace.read("large.txt"),
      empty: await workspace.read("empty.txt"),
      missingRange: await workspace.read("empty.txt", { offset: 2 }),
    })`);
    expect(result.large).toMatchObject({ truncated: true, lines: 1 });
    expect(result.large).not.toHaveProperty("totalLines");
    expect(result.large.content.length).toBeLessThan(100_000);
    expect(result.empty.content).toBe(`${lineAnchor(1, "")}|`);
    expect(result.missingRange.content).toBe("");
  });

  it("validates read arguments and supports @-prefixed paths", async () => {
    await writeFile(join(cwd, "at.txt"), "contents", "utf8");
    expect(
      await value(`async ({ workspace }) => workspace.read("@at.txt", { format: "raw" })`),
    ).toMatchObject({
      content: "contents",
    });
    const errors = await value(`async ({ workspace }) => {
      const raw = workspace as any;
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

  it("creates, anchors, rewrites, and deletes through one edit method", async () => {
    const original = "one\ntwo\nthree";
    const created = await value(`async ({ workspace }) => workspace.edit("single-edit.txt", {
      revision: null,
      changes: [{ kind: "replaceFile", content: ${JSON.stringify(original)} }],
    })`);
    expect(created).toMatchObject({ file: "single-edit.txt", applied: 1, deleted: false });

    const next = "one\nsecond\nthree\nfour";
    const anchored = await value(`async ({ workspace }) => workspace.edit("single-edit.txt", {
      revision: ${JSON.stringify(fileRevision(original))},
      changes: [
        { kind: "replace", start: ${JSON.stringify(lineAnchor(2, "two"))}, content: "second" },
        { kind: "insertAfter", anchor: ${JSON.stringify(lineAnchor(3, "three"))}, content: "four" },
      ],
    })`);
    expect(await readFile(join(cwd, "single-edit.txt"), "utf8")).toBe(next);
    expect(anchored.revision).toBe(fileRevision(next));

    const rewritten = await value(`async ({ workspace }) => workspace.edit("single-edit.txt", {
      revision: ${JSON.stringify(fileRevision(next))},
      changes: [{ kind: "replaceFile", content: "rewritten" }],
    })`);
    expect(rewritten.revision).toBe(fileRevision("rewritten"));

    await expect(
      run(`async ({ workspace }) => workspace.edit("single-edit.txt", {
        revision: ${JSON.stringify(fileRevision(next))}, changes: [{ kind: "deleteFile" }],
      })`),
    ).rejects.toThrow(/Revision mismatch/);

    const deleted = await value(`async ({ workspace }) => workspace.edit("single-edit.txt", {
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
        await value(`async ({ workspace }) => workspace.edit(${JSON.stringify(outside)}, {
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
        cwd,
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
    const settled = await value(`async ({ workspace }) => workspace.batch([
      { kind: "read", file: "present.txt", options: { format: "raw" } },
      { kind: "read", file: "missing.txt" },
    ], { failure: "settled" })`);
    expect(settled.results[0]).toMatchObject({ kind: "read", index: 0, ok: true });
    expect(settled.results[0].value.content).toBe("present");
    expect(settled.results[1]).toMatchObject({ kind: "read", index: 1, ok: false });
    expect(settled.results[1].error).toContain("ENOENT");

    await expect(
      run(`async ({ workspace }) => workspace.batch([
        { kind: "read", file: "present.txt" }, { kind: "read", file: "missing.txt" },
      ])`),
    ).rejects.toThrow(/ENOENT/);
  });

  it("commits all-edit batches transactionally", async () => {
    const first = "first";
    await writeFile(join(cwd, "delete.txt"), "delete", "utf8");
    await writeFile(join(cwd, "first.txt"), first, "utf8");
    const result = await value(`async ({ workspace }) => workspace.batch([
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
      run(`async ({ workspace }) => workspace.batch([
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
      run(`async ({ workspace }) => workspace.batch([
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
      run(`async ({ workspace }) => workspace.batch([
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
    const errors = await value(`async ({ workspace }) => {
      const raw = workspace as any;
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
    const result = await value(`async ({ workspace }) => ({
      list: await workspace.list(),
      nestedList: await workspace.list("nested"),
      glob: await workspace.glob("**/*.txt", { onlyFiles: true, limit: 1 }),
      defaultGlob: await workspace.glob(),
      filteredGlob: await workspace.glob(["**/*.txt"], { ignore: ["second.txt"] }),
      stat: await workspace.stat("existing.txt"),
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
    expect(result.stat).toMatchObject({ size: 3, file: true, directory: false });
  });

  it("validates glob limits", async () => {
    const errors = await value(`async ({ workspace }) => {
      const capture = async (limit) => { try { await workspace.glob("*", { limit }); return "ok"; } catch (error) { return error.message; } };
      return [await capture(0), await capture(10001)];
    }`);
    expect(errors.join("\n")).toContain("integer between 1 and 10000");
  });
});

describe("workspace search", () => {
  it("returns edit-ready anchors, revisions, and bounded context", async () => {
    await mkdir(join(cwd, "search"));
    await writeFile(join(cwd, "search/a.txt"), "Alpha\nneedle one\nNEEDLE two\nend", "utf8");
    await writeFile(join(cwd, "search/b.txt"), "nothing here", "utf8");
    await writeFile(join(cwd, "search/binary.bin"), Buffer.from([0, 1, 2]));
    await writeFile(join(cwd, "search/huge.txt"), "x".repeat(1_000_001), "utf8");
    await writeFile(join(cwd, "search/unreadable.txt"), "needle", "utf8");
    await chmod(join(cwd, "search/unreadable.txt"), 0o000);

    const result = await value(`async ({ workspace }) => workspace.search("needle", {
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
    const filtered = await value(`async ({ workspace }) => workspace.search("Needle", {
      glob: ["search/*.txt"], ignore: ["**/b.txt"], dot: true,
    })`);
    expect(filtered.matches[0]).toMatchObject({
      file: "search/crlf.txt",
      text: "Needle",
      anchor: lineAnchor(1, "Needle"),
    });

    const regex = await value(`async ({ workspace }) => workspace.search("^n.*e", {
      path: "search/a.txt", regex: true, caseSensitive: false, limit: 1,
    })`);
    expect(regex.matches[0]).toMatchObject({ line: 2, anchor: lineAnchor(2, "needle one") });
    expect(regex.truncated).toBe(true);

    const zeroLength = await value(`async ({ workspace }) => workspace.search("^", {
      path: "search/a.txt", regex: true, limit: 10,
    })`);
    expect(zeroLength.matches).toHaveLength(4);

    const defaults = await value(`async ({ workspace }) => workspace.search("Alpha")`);
    expect(defaults.matches[0]).toMatchObject({ file: "search/a.txt", line: 1 });
  });

  it("interrupts pathological regexes and validates search options", async () => {
    await writeFile(join(cwd, "regex.txt"), `${"a".repeat(30_000)}!`, "utf8");
    await expect(
      run(
        `async ({ workspace }) => workspace.search("^(a+)+$", { path: "regex.txt", regex: true })`,
      ),
    ).rejects.toThrow(/Regex search exceeded 250ms/);

    execFileSync("mkfifo", [join(cwd, "search-pipe")]);
    const errors = await value(`async ({ workspace }) => {
      const raw = workspace as any;
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
