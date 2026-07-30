import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupHarness,
  context,
  cwd,
  execMock,
  run,
  sessionTree,
  setupHarness,
  value,
} from "./extension-fixture.js";

beforeEach(setupHarness);
afterEach(cleanupHarness);

describe("host capabilities", () => {
  it("suggests naming repeatedly generated shell workflows once", async () => {
    const source = `async ({ shell }) => shell.exec("npm test")`;
    expect((await run(source)).content[0].text).not.toContain("Repeated shell command");
    const repeated = await run(source);
    expect(repeated.content[0].text).toContain("Repeated shell command detected");
    expect(repeated.content[0].text).toContain("recurring multi-step workflow");
    expect(repeated.content[0].text).toContain("higher-level named workflow");
    expect((await run(source)).content[0].text).not.toContain("Repeated shell command");

    await run(`async function runChecks({ shell }) { return shell.exec("npm run check"); }`);
    const namedRepeat = await run(`runChecks()`);
    expect(namedRepeat.content[0].text).not.toContain("Repeated shell command");

    const pushSource = `async ({ shell }) => shell.exec("git push")`;
    await run(pushSource);
    const repeatedPush = await run(pushSource);
    expect(repeatedPush.content[0].text).toContain("Existing saved functions: runChecks");
    expect(repeatedPush.content[0].text).toContain("Compose existing saved functions");

    sessionTree({}, context());
    expect((await run(source)).content[0].text).not.toContain("Repeated shell command");
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

  it("raises on nonzero shell exits when requested", async () => {
    execMock.mockResolvedValueOnce({ stdout: "partial output", stderr: "command failed", code: 7 });
    await expect(run(`async ({ shell }) => shell.exec("failing", { raise: true })`))
      .rejects.toThrow(/Command failed with exit code 7: failing[^]*command failed/);

    execMock.mockResolvedValueOnce({ stdout: "ok", stderr: "", code: 0 });
    expect(await value(`async ({ shell }) => shell.exec("passing", { raise: true })`))
      .toMatchObject({ stdout: "ok", code: 0 });

    execMock.mockResolvedValueOnce({ stdout: "stdout failure", stderr: "", code: 2 });
    await expect(run(`async ({ shell }) => shell.exec("stdout-only", { raise: true })`))
      .rejects.toThrow(/stdout-only[^]*stdout failure/);
    execMock.mockResolvedValueOnce({ stdout: "", stderr: "", code: 3 });
    await expect(run(`async ({ shell }) => shell.exec("silent", { raise: true })`))
      .rejects.toThrow("Command failed with exit code 3: silent");

    await expect(run(`async ({ shell }) => shell.exec("bad", { raise: "yes" })`))
      .rejects.toThrow(/string.*boolean/);
    await expect(run(`async ({ shell }) => (shell as any).exec("bad", { raise: "yes" })`))
      .rejects.toThrow("options.raise must be a boolean");
  });

  it("validates shell calls and rejects unknown capabilities", async () => {
    expect(await value(`async ({ shell }) => shell.exec("ok")`)).toMatchObject({ code: 0 });
    const errors = await value(`async (capabilities) => {
      const { shell, mystery } = capabilities as any;
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

  it("handles empty and exact-limit HTTP response bodies", async () => {
    const chunked = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1_000_000));
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response("x".repeat(1_000_000)))
      .mockResolvedValueOnce(new Response(chunked));
    vi.stubGlobal("fetch", fetchMock);
    const result = await value(`async ({ http }) => {
      const responses = [
        await http.request("https://example.test/empty"),
        await http.request("https://example.test/exact"),
        await http.request("https://example.test/chunked"),
      ];
      return responses.map((response) => ({ ...response, body: response.body.length }));
    }`);
    expect(result[0]).toMatchObject({ status: 204, body: 0, truncated: false });
    expect(result[1]).toMatchObject({ status: 200, body: 1_000_000, truncated: false });
    expect(result[2]).toMatchObject({ status: 200, body: 1_000_000, truncated: true });
  });

  it("uses default HTTP options and validates arguments", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("small")));
    const result = await value(`async ({ http }) => {
      const ok = await http.request("https://example.test");
      const capture = async (fn) => { try { await fn(); return "ok"; } catch (e) { return e.message; } };
      const raw = http as any;
      return [ok, await capture(() => raw.request(1)), await capture(() => raw.request("x", "bad")), await capture(() => raw.nope("x"))];
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
    expect(result.context).toMatchObject({
      cwd, mode: "interactive", model: "test/model", thinkingLevel: "medium", savedFunctions: [],
    });
    expect(ctx.ui.notify).toHaveBeenCalledWith("Done", "warning");
    expect(ctx.ui.notify).toHaveBeenCalledWith("Again", "info");
  });

  it("handles unavailable and invalid UI operations", async () => {
    const noUi = context({ hasUI: false });
    await expect(run(`async ({ ui }) => ui.confirm("x", "y")`, noUi)).rejects.toThrow("UI is not available");

    const errors = await value(`async ({ ui }) => {
      const capture = async (fn) => { try { await fn(); return "ok"; } catch (e) { return e.message; } };
      const raw = ui as any;
      return [
        await capture(() => raw.confirm(1, "x")),
        await capture(() => raw.select("x", "bad")),
        await capture(() => raw.nope()),
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
  });});
