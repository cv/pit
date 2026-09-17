import { createHash } from "node:crypto";
import { access, chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_ASSET_BYTES = 64 * 1024 * 1024;
const MANIFEST_ASSET = "pit-wasmtime-checksums.json";
const GUEST_ASSET = "pit-queued-quickjs-guest.wasm";
const TARGETS = new Set([
  "linux-arm64",
  "linux-x64",
  "darwin-arm64",
  "darwin-x64",
  "win32-arm64",
  "win32-x64",
]);

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function download(url, fetchAsset) {
  const response = await fetchAsset(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) {
    throw new Error(`download failed (${response.status}) for ${url}`);
  }
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > MAX_ASSET_BYTES) {
    throw new Error(`release asset exceeds ${MAX_ASSET_BYTES} bytes`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_ASSET_BYTES) {
    throw new Error(`release asset exceeds ${MAX_ASSET_BYTES} bytes`);
  }
  return bytes;
}

function checksum(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function expectedChecksum(manifest, version, file) {
  if (
    !(manifest && typeof manifest === "object" && !Array.isArray(manifest)) ||
    manifest.version !== version ||
    !(manifest.files && typeof manifest.files === "object" && !Array.isArray(manifest.files))
  ) {
    throw new Error("invalid Wasmtime release checksum manifest");
  }
  const value = manifest.files[file];
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`missing Wasmtime checksum for ${file}`);
  }
  return value;
}

async function writeAtomic(path, bytes, mode) {
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, bytes, { mode });
  try {
    await chmod(temporary, mode);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function installWasmtime({
  root = PACKAGE_ROOT,
  version,
  platform = process.platform,
  architecture = process.arch,
  environment = process.env,
  fetchAsset = globalThis.fetch,
  warn = (message) => console.warn(message),
} = {}) {
  if (environment.PIT_SKIP_WASMTIME_INSTALL === "1") {
    return { status: "skipped", reason: "disabled" };
  }
  if (
    environment.PIT_FUNCTION_EXECUTOR === "node" ||
    (environment.PIT_WASMTIME_ADDON && environment.PIT_WASMTIME_COMPONENT)
  ) {
    return { status: "skipped", reason: "configured" };
  }

  const target = `${platform}-${architecture}`;
  if (!TARGETS.has(target)) {
    warn(`[pit] No Wasmtime prebuild is published for ${target}; Pit will use Node.`);
    return { status: "fallback", target };
  }

  const directory = resolve(root, "native", "prebuilds", target);
  const addonPath = resolve(directory, "pit_wasmtime_executor.node");
  const componentPath = resolve(directory, "pit_queued_quickjs_guest.wasm");
  if ((await exists(addonPath)) && (await exists(componentPath))) {
    return { status: "existing", target, addonPath, componentPath };
  }

  let packageVersion = version;
  if (!packageVersion) {
    const manifest = JSON.parse(
      await (await import("node:fs/promises")).readFile(resolve(root, "package.json"), "utf8"),
    );
    packageVersion = manifest.version;
  }
  const releaseBase =
    environment.PIT_WASMTIME_RELEASE_URL ??
    `https://github.com/cv/pit/releases/download/v${packageVersion}`;
  const addonAsset = `pit-wasmtime-${target}.node`;

  try {
    const manifestBytes = await download(`${releaseBase}/${MANIFEST_ASSET}`, fetchAsset);
    const releaseManifest = JSON.parse(manifestBytes.toString("utf8"));
    const [addon, component] = await Promise.all([
      download(`${releaseBase}/${addonAsset}`, fetchAsset),
      download(`${releaseBase}/${GUEST_ASSET}`, fetchAsset),
    ]);
    if (checksum(addon) !== expectedChecksum(releaseManifest, packageVersion, addonAsset)) {
      throw new Error(`checksum mismatch for ${addonAsset}`);
    }
    if (checksum(component) !== expectedChecksum(releaseManifest, packageVersion, GUEST_ASSET)) {
      throw new Error(`checksum mismatch for ${GUEST_ASSET}`);
    }
    await mkdir(directory, { recursive: true });
    await writeAtomic(addonPath, addon, 0o755);
    await writeAtomic(componentPath, component, 0o644);
    return { status: "downloaded", target, addonPath, componentPath };
  } catch (error) {
    if (environment.PIT_WASMTIME_INSTALL_STRICT === "1") throw error;
    const message = error instanceof Error ? error.message : String(error);
    warn(
      `[pit] Could not install the ${target} Wasmtime prebuild (${message}); Pit will use Node.`,
    );
    return { status: "fallback", target };
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  const result = await installWasmtime();
  if (result.status === "downloaded") {
    process.stdout.write(`[pit] Installed Wasmtime prebuild for ${result.target}.\n`);
  }
}
