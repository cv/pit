import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupHarness, cwd, run, setupHarness, value } from "./extension-fixture.js";

beforeEach(setupHarness);
afterEach(cleanupHarness);

describe("workspace capability", () => {
  it("reads, writes, edits, lists, globs, and stats workspace files", async () => {
    await writeFile(join(cwd, "existing.txt"), "one\ntwo\nthree\n", "utf8");
    await symlink(join(cwd, "existing.txt"), join(cwd, "link.txt"));

    const result = await value(`async ({ workspace }) => {
      const written = await workspace.writeText("nested/new.txt", "hello world");
      const edited = await workspace.editText("nested/new.txt", [
        { oldText: "hello", newText: "goodbye" },
        { oldText: "world", newText: "moon" },
      ]);
      return {
        written, edited,
        read: await workspace.readText("existing.txt", { offset: 2, limit: 1 }),
        stat: await workspace.stat("nested/new.txt"),
        list: await workspace.list(),
        nestedList: await workspace.list("nested"),
        glob: await workspace.glob(["**/*.txt"], { dot: true, onlyFiles: true, ignore: ["nothing/**"] }),
        defaultGlob: await workspace.glob(),
      };
    }`);

    expect(await readFile(join(cwd, "nested/new.txt"), "utf8")).toBe("goodbye moon");
    expect(result.written.bytes).toBe(11);
    expect(result.edited.edits).toBe(2);
    expect(result.read).toMatchObject({ text: "two", offset: 2, lines: 1, totalLines: 4 });
    expect(result.stat).toMatchObject({ size: 12, directory: false, file: true });
    expect(result.list).toEqual(
      expect.arrayContaining([
        { name: "existing.txt", type: "file" },
        { name: "link.txt", type: "symlink" },
        { name: "nested", type: "directory" },
      ]),
    );
    expect(result.nestedList).toEqual([{ name: "new.txt", type: "file" }]);
    expect(result.glob).toContain("nested/new.txt");
    expect(result.defaultGlob).toContain("nested");
  });

  it("searches workspace text with structured bounded results", async () => {
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
        path: "search/a.txt",
        line: 2,
        column: 1,
        text: "needle one",
        before: ["Alpha"],
        after: ["NEEDLE two"],
      },
      {
        path: "search/a.txt",
        line: 3,
        column: 1,
        text: "NEEDLE two",
        before: ["needle one"],
        after: ["end"],
      },
    ]);
    expect(result).toMatchObject({ truncated: false, filesSearched: 2, filesSkipped: 3 });
    await chmod(join(cwd, "search/unreadable.txt"), 0o600);

    const regex = await value(`async ({ workspace }) => workspace.search("^n.*e", {
      path: "search/a.txt", regex: true, caseSensitive: false, limit: 1,
    })`);
    expect(regex.matches[0]).toMatchObject({ line: 2, column: 1 });
    expect(regex.truncated).toBe(true);

    const zeroLength = await value(`async ({ workspace }) => workspace.search("^", {
      path: "search/a.txt", regex: true, limit: 10,
    })`);
    expect(zeroLength.matches).toHaveLength(4);

    const defaults = await value(`async ({ workspace }) => workspace.search("Alpha", {
      glob: ["search/*.txt"], ignore: ["**/b.txt"], dot: true, regex: false,
    })`);
    expect(defaults.matches).toEqual([
      expect.objectContaining({ path: "search/a.txt", line: 1, column: 1 }),
    ]);
  });

  it("validates workspace search options", async () => {
    execFileSync("mkfifo", [join(cwd, "search-pipe")]);
    const errors = await value(`async ({ workspace }) => {
      const raw = workspace as any;
      const capture = async (query, options) => { try { await raw.search(query, options); return "ok"; } catch (error) { return error.message; } };
      return [
        await capture("", {}),
        await capture("x", { contextLines: 11 }),
        await capture("x", { limit: 0 }),
        await capture("[", { regex: true }),
        await capture("x", { contextLines: 1.5 }),
        await capture("x", { contextLines: -1 }),
        await capture("x", { limit: 501 }),
        await capture("x", { limit: 1.5 }),
        await capture(42, {}),
        await capture("x", "bad"),
        await capture("x", { path: "search-pipe" }),
      ];
    }`);
    expect(errors[0]).toContain("must not be empty");
    expect(errors[1]).toContain("contextLines");
    expect(errors[2]).toContain("limit");
    expect(errors[3]).toContain("Invalid search regex");
    expect(errors[4]).toContain("contextLines");
    expect(errors[5]).toContain("contextLines");
    expect(errors[6]).toContain("limit");
    expect(errors[7]).toContain("limit");
    expect(errors[8]).toContain("query must be a string");
    expect(errors[9]).toContain("options must be an object");
    expect(errors[10]).toContain("search path must be a file or directory");
  });

  it("commits multi-file workspace batches transactionally", async () => {
    await writeFile(join(cwd, "a.txt"), "before", "utf8");
    const result = await value(`async ({ workspace }) => workspace.batch([
      { kind: "edit", path: "a.txt", edits: [{ oldText: "before", newText: "after" }] },
      { kind: "write", path: "nested/b.txt", contents: "created" },
    ])`);
    expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("after");
    expect(await readFile(join(cwd, "nested/b.txt"), "utf8")).toBe("created");
    expect(result.files).toHaveLength(2);
    expect(result.files[0]).toMatchObject({ kind: "edit", edits: 1 });

    await expect(
      run(`async ({ workspace }) => workspace.batch([
      { kind: "write", path: "untouched.txt", contents: "must not exist" },
      { kind: "edit", path: "a.txt", edits: [{ oldText: "missing", newText: "x" }] },
    ])`),
    ).rejects.toThrow("oldText was not found");
    await expect(readFile(join(cwd, "untouched.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("after");
  });

  it("rolls back committed batch writes after a later write failure", async () => {
    await writeFile(join(cwd, "a-existing.txt"), "original", "utf8");
    await writeFile(join(cwd, "z-parent"), "not a directory", "utf8");
    await expect(
      run(`async ({ workspace }) => workspace.batch([
      { kind: "write", path: "a-existing.txt", contents: "changed" },
      { kind: "write", path: "z-parent/child.txt", contents: "fails" },
    ])`),
    ).rejects.toThrow();
    expect(await readFile(join(cwd, "a-existing.txt"), "utf8")).toBe("original");

    await expect(
      run(`async ({ workspace }) => workspace.batch([
      { kind: "write", path: "a-new.txt", contents: "temporary" },
      { kind: "write", path: "z-parent/child.txt", contents: "fails" },
    ])`),
    ).rejects.toThrow();
    await expect(readFile(join(cwd, "a-new.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("validates workspace batch operations", async () => {
    await mkdir(join(cwd, "directory"));
    const errors = await value(`async ({ workspace }) => {
      const raw = workspace as any;
      const capture = async (fn) => { try { await fn(); return "ok"; } catch (error) { return error.message; } };
      return [
        await capture(() => raw.batch([])),
        await capture(() => raw.batch("bad")),
        await capture(() => raw.batch([null])),
        await capture(() => raw.batch([{ kind: 42, path: "a" }])),
        await capture(() => raw.batch([{ kind: "write", path: "a", contents: 42 }])),
        await capture(() => raw.batch([{ kind: "unknown", path: "a" }])),
        await capture(() => raw.batch([
          { kind: "write", path: "same", contents: "a" },
          { kind: "write", path: "same", contents: "b" },
        ])),
        await capture(() => raw.batch([{ kind: "edit", path: "missing", edits: [] }])),
        await capture(() => raw.batch([{ kind: "write", path: "directory", contents: "x" }])),
      ];
    }`);
    expect(errors[0]).toContain("non-empty array");
    expect(errors[1]).toContain("non-empty array");
    expect(errors[2]).toContain("must be an object");
    expect(errors[3]).toContain("kind must be a string");
    expect(errors[4]).toContain("contents must be a string");
    expect(errors[5]).toContain("Unknown batch operation");
    expect(errors[6]).toContain("unique paths");
    expect(errors[7]).toContain("cannot edit a missing file");
    expect(errors[8]).not.toBe("ok");
  });

  it("applies multi-file unified patches transactionally", async () => {
    await writeFile(join(cwd, "first.txt"), "old first\n", "utf8");
    await writeFile(join(cwd, "second.txt"), "old second\n", "utf8");
    const patch = [
      "--- a/first.txt",
      "+++ b/first.txt",
      "@@ -1 +1 @@",
      "-old first",
      "+new first",
      "--- a/second.txt",
      "+++ b/second.txt",
      "@@ -1 +1 @@",
      "-old second",
      "+new second",
      "",
    ].join("\n");
    const result = await value(
      `async ({ workspace }) => workspace.applyPatch(${JSON.stringify(patch)})`,
    );
    expect(await readFile(join(cwd, "first.txt"), "utf8")).toBe("new first\n");
    expect(await readFile(join(cwd, "second.txt"), "utf8")).toBe("new second\n");
    expect(result.files).toEqual([
      expect.objectContaining({ kind: "modify", hunks: 1 }),
      expect.objectContaining({ kind: "modify", hunks: 1 }),
    ]);
  });

  it("creates and deletes files with unified patches", async () => {
    await writeFile(join(cwd, "delete.txt"), "remove me\n", "utf8");
    const patch = [
      "--- /dev/null",
      "+++ b/created.txt",
      "@@ -0,0 +1 @@",
      "+created",
      "--- a/delete.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-remove me",
      "",
    ].join("\n");
    const result = await value(
      `async ({ workspace }) => workspace.applyPatch(${JSON.stringify(patch)})`,
    );
    expect(await readFile(join(cwd, "created.txt"), "utf8")).toBe("created\n");
    await expect(readFile(join(cwd, "delete.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(result.files.map((file: any) => file.kind)).toEqual(["create", "delete"]);
  });

  it("rejects all patch files before committing a failed hunk", async () => {
    await writeFile(join(cwd, "first.txt"), "original\n", "utf8");
    await writeFile(join(cwd, "second.txt"), "actual\n", "utf8");
    const patch = [
      "--- a/first.txt",
      "+++ b/first.txt",
      "@@ -1 +1 @@",
      "-original",
      "+changed",
      "--- a/second.txt",
      "+++ b/second.txt",
      "@@ -1 +1 @@",
      "-not actual",
      "+changed",
      "",
    ].join("\n");
    await expect(
      run(`async ({ workspace }) => workspace.applyPatch(${JSON.stringify(patch)})`),
    ).rejects.toThrow(/failed to apply[\s\S]*rejected hunks/);
    expect(await readFile(join(cwd, "first.txt"), "utf8")).toBe("original\n");
    expect(await readFile(join(cwd, "second.txt"), "utf8")).toBe("actual\n");
  });

  it("validates malformed and unsupported patches", async () => {
    const errors = await value(`async ({ workspace }) => {
      const raw = workspace as any;
      const capture = async (patch) => { try { await raw.applyPatch(patch); return "ok"; } catch (error) { return error.message; } };
      return [
        await capture(""),
        await capture("not a patch"),
        await capture("--- a/missing.txt\\n+++ b/missing.txt\\n@@ -1 +1 @@\\n-old\\n+new\\n"),
      ];
    }`);
    expect(errors[0]).toContain("must not be empty");
    expect(errors[1]).toContain("has no hunks");
    expect(errors[2]).toContain("cannot modify a missing file");
  });

  it("rejects unsupported unified patch features", async () => {
    const apply = (patch: string) =>
      run(`async ({ workspace }) => workspace.applyPatch(${JSON.stringify(patch)})`);
    const changedPath = ["--- a/old.txt", "+++ b/new.txt", "@@ -1 +1 @@", "-old", "+new", ""].join(
      "\n",
    );
    await expect(apply(changedPath)).rejects.toThrow("changes paths");

    const headerless = ["@@ -0,0 +1 @@", "+value", ""].join("\n");
    await expect(apply(headerless)).rejects.toThrow("does not identify a target file");

    const invalid = ["--- a/file", "+++ b/file", "@@ bad @@", ""].join("\n");
    await expect(apply(invalid)).rejects.toThrow("Invalid unified patch");

    const duplicate = [
      "--- /dev/null",
      "+++ b/same.txt",
      "@@ -0,0 +1 @@",
      "+one",
      "--- /dev/null",
      "+++ b/same.txt",
      "@@ -0,0 +1 @@",
      "+two",
      "",
    ].join("\n");
    await expect(apply(duplicate)).rejects.toThrow("at most one diff per file");

    const binary = [
      "diff --git a/file.bin b/file.bin",
      "Binary files a/file.bin and b/file.bin differ",
      "",
    ].join("\n");
    await expect(apply(binary)).rejects.toThrow("binary");

    const rename = [
      "diff --git a/old.txt b/new.txt",
      "similarity index 100%",
      "rename from old.txt",
      "rename to new.txt",
      "",
    ].join("\n");
    await expect(apply(rename)).rejects.toThrow("renames and copies are not supported");

    const copy = [
      "diff --git a/old.txt b/new.txt",
      "similarity index 100%",
      "copy from old.txt",
      "copy to new.txt",
      "",
    ].join("\n");
    await expect(apply(copy)).rejects.toThrow("renames and copies are not supported");

    await expect(
      run(`async ({ workspace }) => (workspace as any).applyPatch("x".repeat(1_000_001))`),
    ).rejects.toThrow("patch exceeds");
  });

  it("validates patch create and delete preconditions", async () => {
    await writeFile(join(cwd, "existing.txt"), "existing\n", "utf8");
    const createExisting = [
      "--- /dev/null",
      "+++ b/existing.txt",
      "@@ -0,0 +1 @@",
      "+new",
      "",
    ].join("\n");
    await expect(
      run(`async ({ workspace }) => workspace.applyPatch(${JSON.stringify(createExisting)})`),
    ).rejects.toThrow("cannot create an existing file");

    const deleteMissing = ["--- a/missing.txt", "+++ /dev/null", "@@ -1 +0,0 @@", "-old", ""].join(
      "\n",
    );
    await expect(
      run(`async ({ workspace }) => workspace.applyPatch(${JSON.stringify(deleteMissing)})`),
    ).rejects.toThrow("cannot delete a missing file");
  });

  it("rolls back patches after a later filesystem failure", async () => {
    await writeFile(join(cwd, "a-existing.txt"), "original\n", "utf8");
    await writeFile(join(cwd, "z-parent"), "not a directory", "utf8");
    const patch = [
      "--- a/a-existing.txt",
      "+++ b/a-existing.txt",
      "@@ -1 +1 @@",
      "-original",
      "+changed",
      "--- /dev/null",
      "+++ b/z-parent/child.txt",
      "@@ -0,0 +1 @@",
      "+created",
      "",
    ].join("\n");
    await expect(
      run(`async ({ workspace }) => workspace.applyPatch(${JSON.stringify(patch)})`),
    ).rejects.toThrow();
    expect(await readFile(join(cwd, "a-existing.txt"), "utf8")).toBe("original\n");

    const createThenFail = [
      "--- /dev/null",
      "+++ b/a-new.txt",
      "@@ -0,0 +1 @@",
      "+temporary",
      "--- /dev/null",
      "+++ b/z-parent/child.txt",
      "@@ -0,0 +1 @@",
      "+created",
      "",
    ].join("\n");
    await expect(
      run(`async ({ workspace }) => workspace.applyPatch(${JSON.stringify(createThenFail)})`),
    ).rejects.toThrow();
    await expect(readFile(join(cwd, "a-new.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("supports @-prefixed workspace paths and default read options", async () => {
    await writeFile(join(cwd, "at.txt"), "contents", "utf8");
    const result = await value(`async ({ workspace }) => workspace.readText("@at.txt")`);
    expect(result.text).toBe("contents");
  });

  it("validates workspace arguments and edits", async () => {
    await writeFile(join(cwd, "edit.txt"), "same same abcdef", "utf8");
    const errors = await value(`async ({ workspace }) => {
      const capture = async (fn) => { try { await fn(); return "ok"; } catch (e) { return e.message; } };
      const raw = workspace as any;
      return Promise.all([
        capture(() => workspace.readText("edit.txt", { offset: 0 })),
        capture(() => workspace.readText("edit.txt", { limit: 1.5 })),
        capture(() => raw.readText("edit.txt", "bad")),
        capture(() => raw.writeText("x", 123)),
        capture(() => workspace.editText("edit.txt", [])),
        capture(() => workspace.editText("edit.txt", [{ oldText: "", newText: "x" }])),
        capture(() => workspace.editText("edit.txt", [{ oldText: "missing", newText: "x" }])),
        capture(() => workspace.editText("edit.txt", [{ oldText: "same", newText: "x" }])),
        capture(() => workspace.editText("edit.txt", [
          { oldText: "abc", newText: "x" }, { oldText: "bcde", newText: "y" },
        ])),
        capture(() => raw.editText("edit.txt", "bad")),
        capture(() => raw.stat(42)),
        capture(() => raw.noSuchMethod()),
      ]);
    }`);
    expect(errors.join("\n")).toMatch(/positive integers/);
    expect(errors.join("\n")).toMatch(/must be an object/);
    expect(errors.join("\n")).toMatch(/contents must be a string/);
    expect(errors.join("\n")).toMatch(/non-empty array/);
    expect(errors.join("\n")).toMatch(/may not be empty/);
    expect(errors.join("\n")).toMatch(/was not found/);
    expect(errors.join("\n")).toMatch(/not unique/);
    expect(errors[7]).toContain("matched 2 times at 1:1, 1:6");
    expect(errors.join("\n")).toMatch(/overlap/);
    expect(errors.join("\n")).toMatch(/path must be a string/);
    expect(errors.join("\n")).toMatch(/Unknown workspace method/);

    await writeFile(join(cwd, "many.txt"), "x".repeat(12), "utf8");
    const manyMatches = await value(`async ({ workspace }) => {
      try { await workspace.editText("many.txt", [{ oldText: "x", newText: "y" }]); return "ok"; }
      catch (error) { return error.message; }
    }`);
    expect(manyMatches).toContain("matched 12 times");
    expect(manyMatches).toContain("and 2 more");
  });
});
