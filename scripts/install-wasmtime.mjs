import { createHash } from "node:crypto";
import { access, chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_ASSET_BYTES = 64 * 1024 * 1024;
const MANIFEST_ASSET = "pit-wasmtime-checksums.json";
const GUEST_ASSET = "pit-queued-quickjs-guest.wasm";
const RELEASE_MARKER = "pit-release.json";
const RELEASES = "https://github.com/cv/pit/releases";
const TARGETS = new Set([
  "linux-arm64",
  "linux-x64",
  "darwin-arm64",
  "darwin-x64",
  "win32-arm64",
  "win32-x64",
]);

class MissingReleaseAsset extends Error {}

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
  if (response.status === 404) {
    throw new MissingReleaseAsset(`release asset not found: ${url}`);
  }
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

function releaseManifest(bytes, version) {
  const manifest = JSON.parse(bytes.toString("utf8"));
  if (
    !(manifest && typeof manifest === "object" && !Array.isArray(manifest)) ||
    typeof manifest.version !== "string" ||
    (version !== undefined && manifest.version !== version) ||
    !(manifest.files && typeof manifest.files === "object" && !Array.isArray(manifest.files))
  ) {
    throw new Error("invalid Wasmtime release checksum manifest");
  }
  return manifest;
}

function expectedChecksum(manifest, file) {
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

async function installedRelease(markerPath) {
  try {
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    return typeof marker?.version === "string" ? marker.version : undefined;
  } catch {
    return undefined;
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
  if (environment.PIT_WASMTIME_ADDON && environment.PIT_WASMTIME_COMPONENT) {
    return { status: "skipped", reason: "configured" };
  }

  const target = `${platform}-${architecture}`;
  if (!TARGETS.has(target)) {
    warn(`[pit] No Wasmtime prebuild is published for ${target}; Pit cannot run TypeScript here.`);
    return { status: "unsupported", target };
  }

  let packageVersion = version;
  if (!packageVersion) {
    packageVersion = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")).version;
  }
  const directory = resolve(root, "native", "prebuilds", target);
  const addonPath = resolve(directory, "pit_wasmtime_executor.node");
  const componentPath = resolve(directory, "pit_queued_quickjs_guest.wasm");
  const markerPath = resolve(directory, RELEASE_MARKER);
  const installed =
    (await exists(addonPath)) && (await exists(componentPath))
      ? await installedRelease(markerPath)
      : undefined;
  // Prebuilds from another release, or of unknown origin, are refreshed rather than trusted.
  if (installed === packageVersion) {
    return { status: "existing", target, release: installed, addonPath, componentPath };
  }

  const explicitBase = environment.PIT_WASMTIME_RELEASE_URL;
  const addonAsset = `pit-wasmtime-${target}.node`;
  try {
    let base = explicitBase ?? `${RELEASES}/download/v${packageVersion}`;
    let manifest;
    try {
      manifest = releaseManifest(
        await download(`${base}/${MANIFEST_ASSET}`, fetchAsset),
        packageVersion,
      );
    } catch (error) {
      if (!(error instanceof MissingReleaseAsset) || explicitBase) throw error;
      // An unreleased version, such as main between a version bump and its tag, uses the newest
      // published release. Its own manifest names the version the checksums belong to.
      base = `${RELEASES}/latest/download`;
      manifest = releaseManifest(await download(`${base}/${MANIFEST_ASSET}`, fetchAsset));
      if (installed === manifest.version) {
        return { status: "existing", target, release: installed, addonPath, componentPath };
      }
      warn(
        `[pit] Wasmtime prebuilds for v${packageVersion} are not published; using v${manifest.version}.`,
      );
    }
    const [addon, component] = await Promise.all([
      download(`${base}/${addonAsset}`, fetchAsset),
      download(`${base}/${GUEST_ASSET}`, fetchAsset),
    ]);
    if (checksum(addon) !== expectedChecksum(manifest, addonAsset)) {
      throw new Error(`checksum mismatch for ${addonAsset}`);
    }
    if (checksum(component) !== expectedChecksum(manifest, GUEST_ASSET)) {
      throw new Error(`checksum mismatch for ${GUEST_ASSET}`);
    }
    await mkdir(directory, { recursive: true });
    await writeAtomic(addonPath, addon, 0o755);
    await writeAtomic(componentPath, component, 0o644);
    await writeAtomic(markerPath, `${JSON.stringify({ version: manifest.version })}\n`, 0o644);
    return { status: "downloaded", target, release: manifest.version, addonPath, componentPath };
  } catch (error) {
    if (environment.PIT_WASMTIME_INSTALL_STRICT === "1") throw error;
    const message = error instanceof Error ? error.message : String(error);
    // Existing prebuilds are left in place, so a failed refresh never removes a working runtime.
    warn(
      `[pit] Could not install the ${target} Wasmtime prebuild (${message}); Pit cannot run TypeScript until it is installed.`,
    );
    return { status: "failed", target };
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  const result = await installWasmtime();
  if (result.status === "downloaded") {
    process.stdout.write(
      `[pit] Installed Wasmtime prebuild v${result.release} for ${result.target}.\n`,
    );
  }
}
