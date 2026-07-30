import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pit, { display } from "../src/index.js";

type RegisteredTool = { execute: (...args: any[]) => Promise<any> };

let cwd: string;
let tool: RegisteredTool;
let sessionStart: () => void;
let execMock: ReturnType<typeof vi.fn>;
let setActiveTools: ReturnType<typeof vi.fn>;

function context(overrides: Record<string, unknown> = {}) {
  return {
    cwd,
    mode: "interactive",
    model: { provider: "test", id: "model" },
    thinkingLevel: "medium",
    hasUI: true,
    ui: {
      confirm: vi.fn(async () => true),
      input: vi.fn(async () => "typed"),
      select: vi.fn(async () => "b"),
      notify: vi.fn(),
    },
    sessionManager: { getSessionFile: () => "/tmp/session.jsonl" },
    ...overrides,
  };
}

async function run(code: string, ctx = context(), signal?: AbortSignal) {
  return tool.execute("call-id", { code }, signal, undefined, ctx);
}

async function value(code: string, ctx = context()) {
  return (await run(code, ctx)).details.value;
}

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "pit-test-"));
  execMock = vi.fn(async () => ({ stdout: "shell out\n", stderr: "", code: 0 }));
  setActiveTools = vi.fn();
  const pi = {
    registerTool: vi.fn((registered: RegisteredTool) => { tool = registered; }),
    on: vi.fn((event: string, callback: () => void) => {
      if (event === "session_start") sessionStart = callback;
    }),
    setActiveTools,
    exec: execMock,
  };
  pit(pi as any);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(cwd, { recursive: true, force: true });
});

describe("display", () => {
  it("falls back when a value cannot be stringified", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(display(circular)).toBe("[object Object]");
  });
});

describe("pit extension", () => {
  it("registers and activates only the TypeScript tool", () => {
    expect(tool).toBeDefined();
    sessionStart();
    expect(setActiveTools).toHaveBeenCalledWith(["typescript"]);
  });

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
    expect(result.list).toEqual(expect.arrayContaining([
      { name: "existing.txt", type: "file" },
      { name: "link.txt", type: "symlink" },
      { name: "nested", type: "directory" },
    ]));
    expect(result.nestedList).toEqual([{ name: "new.txt", type: "file" }]);
    expect(result.glob).toContain("nested/new.txt");
    expect(result.defaultGlob).toContain("nested");
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
      return Promise.all([
        capture(() => workspace.readText("edit.txt", { offset: 0 })),
        capture(() => workspace.readText("edit.txt", { limit: 1.5 })),
        capture(() => workspace.readText("edit.txt", "bad")),
        capture(() => workspace.writeText("x", 123)),
        capture(() => workspace.editText("edit.txt", [])),
        capture(() => workspace.editText("edit.txt", [{ oldText: "", newText: "x" }])),
        capture(() => workspace.editText("edit.txt", [{ oldText: "missing", newText: "x" }])),
        capture(() => workspace.editText("edit.txt", [{ oldText: "same", newText: "x" }])),
        capture(() => workspace.editText("edit.txt", [
          { oldText: "abc", newText: "x" }, { oldText: "bcde", newText: "y" },
        ])),
        capture(() => workspace.editText("edit.txt", "bad")),
        capture(() => workspace.stat(42)),
        capture(() => workspace.noSuchMethod()),
      ]);
    }`);
    expect(errors.join("\n")).toMatch(/positive integers/);
    expect(errors.join("\n")).toMatch(/must be an object/);
    expect(errors.join("\n")).toMatch(/contents must be a string/);
    expect(errors.join("\n")).toMatch(/non-empty array/);
    expect(errors.join("\n")).toMatch(/may not be empty/);
    expect(errors.join("\n")).toMatch(/was not found/);
    expect(errors.join("\n")).toMatch(/not unique/);
    expect(errors.join("\n")).toMatch(/overlap/);
    expect(errors.join("\n")).toMatch(/path must be a string/);
    expect(errors.join("\n")).toMatch(/Unknown workspace method/);
  });

  it("executes shell commands with default and explicit options", async () => {
    execMock
      .mockResolvedValueOnce({ stdout: "first", stderr: "warning", code: 2 })
      .mockResolvedValueOnce({ stdout: "second", stderr: "", code: 0 });
    const controller = new AbortController();
    const result = await run(`async ({ shell }) => [
      await shell.exec("first"),
      await shell.exec("second", { cwd: ".", timeoutMs: 50 }),
    ]`, context(), controller.signal);
    expect(result.details.value[0]).toMatchObject({ stdout: "first", stderr: "warning", code: 2, truncated: false });
    expect(execMock).toHaveBeenNthCalledWith(1, "/bin/sh", ["-lc", "first"], expect.objectContaining({ cwd, signal: controller.signal, timeout: 120_000 }));
    expect(execMock).toHaveBeenNthCalledWith(2, "/bin/sh", ["-lc", "second"], expect.objectContaining({ timeout: 50 }));
  });

  it("validates shell calls and rejects unknown capabilities", async () => {
    expect(await value(`async ({ shell }) => shell.exec("ok")`)).toMatchObject({ code: 0 });
    const errors = await value(`async ({ shell, mystery }) => {
      const capture = async (fn) => { try { await fn(); return "ok"; } catch (e) { return e.message; } };
      return [await capture(() => shell.exec(1)), await capture(() => shell.exec("x", "bad")), await capture(() => mystery.go())];
    }`);
    expect(errors).toEqual(["command must be a string", "options must be an object", "Unknown capability or method: mystery.go"]);
  });

  it("performs HTTP requests and truncates large responses", async () => {
    const fetchMock = vi.fn(async () => new Response("x".repeat(1_000_100), {
      status: 201, headers: { "x-test": "yes" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const result = (await run(`async ({ http }) => {
      const response = await http.request("https://example.test", {
        method: "POST", headers: { "x-input": "yes" }, body: "payload",
      });
      return { ...response, body: response.body.length };
    }`, context(), controller.signal)).details.value;
    expect(result).toMatchObject({ status: 201, ok: true, body: 1_000_000, truncated: true });
    expect(result.headers["x-test"]).toBe("yes");
    expect(fetchMock).toHaveBeenCalledWith("https://example.test", expect.objectContaining({ method: "POST", body: "payload", signal: controller.signal }));
  });

  it("uses default HTTP options and validates arguments", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("small")));
    const result = await value(`async ({ http }) => {
      const ok = await http.request("https://example.test");
      const capture = async (fn) => { try { await fn(); return "ok"; } catch (e) { return e.message; } };
      return [ok, await capture(() => http.request(1)), await capture(() => http.request("x", "bad")), await capture(() => http.nope("x"))];
    }`);
    expect(result[0]).toMatchObject({ body: "small", truncated: false });
    expect(result.slice(1)).toEqual(["url must be a string", "options must be an object", "Unknown capability or method: http.nope"]);
  });

  it("provides UI and context capabilities", async () => {
    const ctx = context();
    const result = await value(`async ({ ui, context }) => ({
      confirmed: await ui.confirm("Confirm", "Sure?"),
      input: await ui.input("Input"),
      inputWithPlaceholder: await ui.input("Input", "hint"),
      selected: await ui.select("Pick", ["a", "b"]),
      notified: await ui.notify("Done", "warning"),
      defaultNotify: await ui.notify("Again"),
      context: await context.get(),
    })`, ctx);
    expect(result).toMatchObject({ confirmed: true, input: "typed", selected: "b", notified: null });
    expect(result.context).toMatchObject({ cwd, mode: "interactive", model: "test/model", thinkingLevel: "medium" });
    expect(ctx.ui.notify).toHaveBeenCalledWith("Done", "warning");
    expect(ctx.ui.notify).toHaveBeenCalledWith("Again", "info");
  });

  it("handles unavailable and invalid UI operations", async () => {
    const noUi = context({ hasUI: false });
    await expect(run(`async ({ ui }) => ui.confirm("x", "y")`, noUi)).rejects.toThrow("UI is not available");

    const errors = await value(`async ({ ui }) => {
      const capture = async (fn) => { try { await fn(); return "ok"; } catch (e) { return e.message; } };
      return [
        await capture(() => ui.confirm(1, "x")),
        await capture(() => ui.select("x", "bad")),
        await capture(() => ui.nope()),
      ];
    }`);
    expect(errors).toEqual(["title must be a string", "options must be an array", "Unknown ui method: nope"]);
  });

  it("handles missing model and renders primitive results", async () => {
    const noModel = context({ model: undefined });
    expect(await value(`async ({ context }) => context.get()`, noModel)).toMatchObject({ cwd });
    expect((await run(`() => "plain text"`)).content[0].text).toBe("plain text");
    expect((await run(`() => undefined`)).content[0].text).toBe("undefined");
  });

  it("truncates oversized tool output", async () => {
    const result = await run(`() => "x".repeat(200000)`);
    expect(result.content[0].text).toContain("[Result truncated]");
    expect(result.details).toEqual({ value: undefined, truncated: true });
  });
});
