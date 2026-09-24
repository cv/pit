import { format } from "oxfmt";
import { afterEach, describe, expect, it, vi } from "vitest";

import { formatTypeScriptSource } from "../../src/tool/source-formatter.js";

vi.mock("oxfmt", async (importOriginal) => {
  const original = await importOriginal<typeof import("oxfmt")>();
  return { ...original, format: vi.fn(original.format) };
});
afterEach(() => vi.clearAllMocks());

describe("source formatting cache", () => {
  it("shares concurrent execution/display requests and settled output", async () => {
    const source = "async({})=>({shared:42})";
    const [execution, display] = await Promise.all([
      formatTypeScriptSource(source),
      formatTypeScriptSource(source),
    ]);
    expect(execution).toBe(display);
    expect(await formatTypeScriptSource(source)).toBe(execution);
    expect(format).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "synchronous exception",
      fail: () => {
        throw new Error("unavailable");
      },
    },
    { name: "asynchronous exception", fail: () => Promise.reject(new Error("unavailable")) },
  ])("retries after a $name without blocking validation", async ({ name, fail }) => {
    const source = `async({})=>({retry:${JSON.stringify(name)}})`;
    vi.mocked(format).mockImplementationOnce(fail);
    expect(await formatTypeScriptSource(source)).toBe(source);
    expect(await formatTypeScriptSource(source)).not.toBe(source);
    expect(format).toHaveBeenCalledTimes(2);
  });

  it("evicts older entries and does not retain oversized submissions", async () => {
    for (let i = 0; i < 65; i++) await formatTypeScriptSource(`async({})=>({evict:${i}})`);
    const calls = vi.mocked(format).mock.calls.length;
    await formatTypeScriptSource("async({})=>({evict:0})");
    expect(vi.mocked(format).mock.calls.length).toBe(calls + 1);
    const large = `async({})=>${JSON.stringify("x".repeat(33000))}`;
    await formatTypeScriptSource(large);
    await formatTypeScriptSource(large);
    expect(vi.mocked(format).mock.calls.length).toBe(calls + 3);
  });
});
