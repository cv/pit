import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { installWasmtime } from "../../scripts/install-wasmtime.mjs";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pit-wasmtime-install-"));
  roots.push(root);
  await writeFile(join(root, "package.json"), JSON.stringify({ version: "0.16.0" }));
  return root;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function response(value: Uint8Array | string): Response {
  return new Response(value as BodyInit);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("installWasmtime", () => {
  it.each([
    { name: "disabled", environment: { PIT_SKIP_WASMTIME_INSTALL: "1" } },
    { name: "Node", environment: { PIT_FUNCTION_EXECUTOR: "node" } },
    {
      name: "custom artifacts",
      environment: { PIT_WASMTIME_ADDON: "/addon", PIT_WASMTIME_COMPONENT: "/guest" },
    },
  ])("skips downloads when $name is configured", async ({ environment }) => {
    const fetchAsset = vi.fn();
    await expect(
      installWasmtime({
        root: await temporaryRoot(),
        version: "0.16.0",
        environment,
        fetchAsset,
      }),
    ).resolves.toMatchObject({ status: "skipped" });
    expect(fetchAsset).not.toHaveBeenCalled();
  });

  it("falls back for an unpublished target", async () => {
    const warn = vi.fn();
    await expect(
      installWasmtime({
        root: await temporaryRoot(),
        version: "0.16.0",
        platform: "freebsd",
        architecture: "riscv64",
        environment: {},
        fetchAsset: vi.fn(),
        warn,
      }),
    ).resolves.toEqual({ status: "fallback", target: "freebsd-riscv64" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("No Wasmtime prebuild"));
  });

  it("keeps complete existing artifacts", async () => {
    const root = await temporaryRoot();
    const directory = join(root, "native", "prebuilds", "darwin-arm64");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(directory, { recursive: true }));
    await Promise.all([
      writeFile(join(directory, "pit_wasmtime_executor.node"), "addon"),
      writeFile(join(directory, "pit_queued_quickjs_guest.wasm"), "guest"),
    ]);
    const fetchAsset = vi.fn();

    await expect(
      installWasmtime({
        root,
        version: "0.16.0",
        platform: "darwin",
        architecture: "arm64",
        environment: {},
        fetchAsset,
      }),
    ).resolves.toMatchObject({ status: "existing", target: "darwin-arm64" });
    expect(fetchAsset).not.toHaveBeenCalled();
  });

  it("downloads and verifies the matching addon and shared guest", async () => {
    const root = await temporaryRoot();
    const addon = Buffer.from("darwin addon");
    const guest = Buffer.from([0, 97, 115, 109]);
    const checksums = JSON.stringify({
      version: "0.16.0",
      files: {
        "pit-wasmtime-darwin-arm64.node": sha256(addon),
        "pit-queued-quickjs-guest.wasm": sha256(guest),
      },
    });
    const fetchAsset = vi.fn(async (url: string) =>
      response(url.endsWith("checksums.json") ? checksums : url.endsWith(".node") ? addon : guest),
    );

    const result = await installWasmtime({
      root,
      version: "0.16.0",
      platform: "darwin",
      architecture: "arm64",
      environment: { PIT_WASMTIME_RELEASE_URL: "https://release.test" },
      fetchAsset,
    });

    expect(result).toMatchObject({ status: "downloaded", target: "darwin-arm64" });
    await expect(
      readFile(join(root, "native", "prebuilds", "darwin-arm64", "pit_wasmtime_executor.node")),
    ).resolves.toEqual(addon);
    await expect(
      readFile(join(root, "native", "prebuilds", "darwin-arm64", "pit_queued_quickjs_guest.wasm")),
    ).resolves.toEqual(guest);
    expect(fetchAsset).toHaveBeenCalledTimes(3);
  });

  it("falls back after checksum failure and can make installation strict", async () => {
    const root = await temporaryRoot();
    const manifest = JSON.stringify({
      version: "0.16.0",
      files: {
        "pit-wasmtime-win32-x64.node": "0".repeat(64),
        "pit-queued-quickjs-guest.wasm": "0".repeat(64),
      },
    });
    const fetchAsset = vi.fn(async (url: string) =>
      response(url.endsWith("checksums.json") ? manifest : "wrong"),
    );
    const warn = vi.fn();
    const base = {
      root,
      version: "0.16.0",
      platform: "win32" as const,
      architecture: "x64",
      fetchAsset,
      warn,
    };

    await expect(installWasmtime({ ...base, environment: {} })).resolves.toEqual({
      status: "fallback",
      target: "win32-x64",
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("checksum mismatch"));
    await expect(
      installWasmtime({
        ...base,
        environment: { PIT_WASMTIME_INSTALL_STRICT: "1" },
      }),
    ).rejects.toThrow("checksum mismatch");
    await expect(
      access(join(root, "native", "prebuilds", "win32-x64", "pit_wasmtime_executor.node")),
    ).rejects.toThrow();
  });
});
