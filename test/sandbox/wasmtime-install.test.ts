import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { installWasmtime } from "../../scripts/install-wasmtime.mjs";

const roots: string[] = [];
const addon = Buffer.from("darwin addon");
const guest = Buffer.from([0, 97, 115, 109]);

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pit-wasmtime-install-"));
  roots.push(root);
  await writeFile(join(root, "package.json"), JSON.stringify({ version: "0.16.0" }));
  return root;
}

const prebuildDirectory = (root: string) => join(root, "native", "prebuilds", "darwin-arm64");

async function existingPrebuild(root: string, release?: string): Promise<void> {
  const directory = prebuildDirectory(root);
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(join(directory, "pit_wasmtime_executor.node"), "old addon"),
    writeFile(join(directory, "pit_queued_quickjs_guest.wasm"), "old guest"),
    ...(release
      ? [writeFile(join(directory, "pit-release.json"), JSON.stringify({ version: release }))]
      : []),
  ]);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function manifest(version: string, addonChecksum = sha256(addon)): string {
  return JSON.stringify({
    version,
    files: {
      "pit-wasmtime-darwin-arm64.node": addonChecksum,
      "pit-queued-quickjs-guest.wasm": sha256(guest),
    },
  });
}

/** A release host: each base serves a manifest and the assets, or nothing (404). */
function releases(published: Record<string, string>) {
  return vi.fn(async (url: string) => {
    const base = Object.keys(published).find((prefix) => url.startsWith(`${prefix}/`));
    if (!base) return new Response("missing", { status: 404 });
    if (url.endsWith("checksums.json")) return new Response(published[base]);
    return new Response(url.endsWith(".node") ? addon : guest);
  });
}

const exact = "https://github.com/cv/pit/releases/download/v0.16.0";
const latest = "https://github.com/cv/pit/releases/latest/download";
const darwin = { version: "0.16.0", platform: "darwin" as const, architecture: "arm64" };

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("installWasmtime", () => {
  it.each([
    { name: "disabled", environment: { PIT_SKIP_WASMTIME_INSTALL: "1" } },
    {
      name: "custom artifacts",
      environment: { PIT_WASMTIME_ADDON: "/addon", PIT_WASMTIME_COMPONENT: "/guest" },
    },
  ])("skips downloads when $name is configured", async ({ environment }) => {
    const fetchAsset = vi.fn();
    await expect(
      installWasmtime({ root: await temporaryRoot(), ...darwin, environment, fetchAsset }),
    ).resolves.toMatchObject({ status: "skipped" });
    expect(fetchAsset).not.toHaveBeenCalled();
  });

  it("reports an unpublished target without downloading", async () => {
    const warn = vi.fn();
    const fetchAsset = vi.fn();
    await expect(
      installWasmtime({
        root: await temporaryRoot(),
        version: "0.16.0",
        platform: "freebsd",
        architecture: "riscv64",
        environment: {},
        fetchAsset,
        warn,
      }),
    ).resolves.toEqual({ status: "unsupported", target: "freebsd-riscv64" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("cannot run TypeScript"));
    expect(fetchAsset).not.toHaveBeenCalled();
  });

  it("keeps a prebuild installed from this version's release", async () => {
    const root = await temporaryRoot();
    await existingPrebuild(root, "0.16.0");
    const fetchAsset = vi.fn();

    await expect(
      installWasmtime({ root, ...darwin, environment: {}, fetchAsset }),
    ).resolves.toMatchObject({ status: "existing", release: "0.16.0" });
    expect(fetchAsset).not.toHaveBeenCalled();
  });

  it.each([
    { name: "of unknown origin", release: undefined },
    { name: "from an older release", release: "0.15.0" },
  ])("refreshes a prebuild $name", async ({ release }) => {
    const root = await temporaryRoot();
    await existingPrebuild(root, release);

    await expect(
      installWasmtime({
        root,
        ...darwin,
        environment: {},
        fetchAsset: releases({ [exact]: manifest("0.16.0") }),
      }),
    ).resolves.toMatchObject({ status: "downloaded", release: "0.16.0" });
    await expect(
      readFile(join(prebuildDirectory(root), "pit_wasmtime_executor.node")),
    ).resolves.toEqual(addon);
    await expect(
      readFile(join(prebuildDirectory(root), "pit-release.json"), "utf8"),
    ).resolves.toContain('"version":"0.16.0"');
  });

  it("downloads and verifies the exact release", async () => {
    const root = await temporaryRoot();
    const fetchAsset = releases({ [exact]: manifest("0.16.0") });

    await expect(
      installWasmtime({ root, ...darwin, environment: {}, fetchAsset }),
    ).resolves.toMatchObject({ status: "downloaded", target: "darwin-arm64", release: "0.16.0" });
    await expect(
      readFile(join(prebuildDirectory(root), "pit_queued_quickjs_guest.wasm")),
    ).resolves.toEqual(guest);
    expect(fetchAsset).toHaveBeenCalledTimes(3);
  });

  it("uses the latest release when this version is not published", async () => {
    const root = await temporaryRoot();
    const warn = vi.fn();

    await expect(
      installWasmtime({
        root,
        ...darwin,
        environment: {},
        fetchAsset: releases({ [latest]: manifest("0.15.0") }),
        warn,
      }),
    ).resolves.toMatchObject({ status: "downloaded", release: "0.15.0" });
    expect(warn).toHaveBeenCalledWith(
      "[pit] Wasmtime prebuilds for v0.16.0 are not published; using v0.15.0.",
    );
    await expect(
      readFile(join(prebuildDirectory(root), "pit-release.json"), "utf8"),
    ).resolves.toContain('"version":"0.15.0"');
  });

  it("keeps a prebuild already installed from the latest release", async () => {
    const root = await temporaryRoot();
    await existingPrebuild(root, "0.15.0");
    const fetchAsset = releases({ [latest]: manifest("0.15.0") });

    await expect(
      installWasmtime({ root, ...darwin, environment: {}, fetchAsset, warn: vi.fn() }),
    ).resolves.toMatchObject({ status: "existing", release: "0.15.0" });
    // Only the two manifests were requested; no assets were downloaded again.
    expect(fetchAsset).toHaveBeenCalledTimes(2);
  });

  it("does not substitute another release for an explicit release URL", async () => {
    const warn = vi.fn();
    await expect(
      installWasmtime({
        root: await temporaryRoot(),
        ...darwin,
        environment: { PIT_WASMTIME_RELEASE_URL: "https://release.test" },
        fetchAsset: releases({ [latest]: manifest("0.15.0") }),
        warn,
      }),
    ).resolves.toEqual({ status: "failed", target: "darwin-arm64" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("release asset not found"));
  });

  it("keeps working files after a checksum failure and can make installation strict", async () => {
    const root = await temporaryRoot();
    await existingPrebuild(root, "0.15.0");
    const warn = vi.fn();
    const base = {
      root,
      ...darwin,
      fetchAsset: releases({ [exact]: manifest("0.16.0", "0".repeat(64)) }),
      warn,
    };

    await expect(installWasmtime({ ...base, environment: {} })).resolves.toEqual({
      status: "failed",
      target: "darwin-arm64",
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("checksum mismatch"));
    await expect(
      readFile(join(prebuildDirectory(root), "pit_wasmtime_executor.node"), "utf8"),
    ).resolves.toBe("old addon");
    await expect(
      installWasmtime({ ...base, environment: { PIT_WASMTIME_INSTALL_STRICT: "1" } }),
    ).rejects.toThrow("checksum mismatch");
  });

  it("writes nothing when the first install fails", async () => {
    const root = await temporaryRoot();
    await installWasmtime({
      root,
      ...darwin,
      environment: {},
      fetchAsset: releases({ [exact]: manifest("0.16.0", "0".repeat(64)) }),
      warn: vi.fn(),
    });
    await expect(
      access(join(prebuildDirectory(root), "pit_wasmtime_executor.node")),
    ).rejects.toThrow();
  });
});
