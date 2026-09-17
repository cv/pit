import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));

const readme = await readFile(resolve(root, "README.md"), "utf8");
const piProvided = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"];
const requiredRuntimeFiles = [
  "src/index.ts",
  "src/sandbox/run.ts",
  "src/sandbox/node-executor.ts",
  "src/sandbox/runner.mjs",
  "native/prebuilds/linux-arm64/pit_wasmtime_executor.node",
  "native/prebuilds/linux-arm64/pit_queued_quickjs_guest.wasm",
  "src/generated/capability-contract.d.ts",
  "prompts/pit-reflect.md",
  "docs/architecture.md",
  "docs/releasing.md",
  "CHANGELOG.md",
  "SECURITY.md",
];

function fail(message) {
  throw new Error(`Package verification failed: ${message}`);
}

if (packageJson.private !== true) {
  fail("GitHub-distributed Pit must remain private to npm");
}

const installReference = `git:github.com/cv/pit@v${packageJson.version}`;
if (readme.split(installReference).length - 1 < 3) {
  fail(`README.md must use ${installReference} in pinned install examples`);
}

if (!Array.isArray(packageJson.pi?.extensions) || packageJson.pi.extensions.length === 0) {
  fail("package.json must declare at least one pi.extensions entry");
}

if (!packageJson.pi.prompts?.includes("./prompts")) {
  fail("package.json must register ./prompts in pi.prompts");
}

if (!packageJson.files?.includes("prompts")) {
  fail("package.json files must include the prompts directory");
}

if (!packageJson.files?.includes("docs")) {
  fail("package.json files must include the docs directory");
}

for (const file of ["CHANGELOG.md", "SECURITY.md"]) {
  if (!packageJson.files?.includes(file)) {
    fail(`package.json files must include ${file}`);
  }
}

const declaredExtensions = packageJson.pi.extensions.map((entry) => {
  if (typeof entry !== "string") {
    fail("pi.extensions entries must be strings");
  }
  return entry.startsWith("./") ? entry.slice(2) : entry;
});

for (const path of new Set([...requiredRuntimeFiles, ...declaredExtensions])) {
  await access(resolve(root, path));
}

const wasmtimeAddon = await readFile(
  resolve(root, "native/prebuilds/linux-arm64/pit_wasmtime_executor.node"),
);
if (
  wasmtimeAddon.length < 20 ||
  wasmtimeAddon.subarray(0, 4).toString("hex") !== "7f454c46" ||
  wasmtimeAddon.readUInt16LE(18) !== 183
) {
  fail("Wasmtime addon must be a Linux ARM64 ELF binary");
}
const quickjsGuest = await readFile(
  resolve(root, "native/prebuilds/linux-arm64/pit_queued_quickjs_guest.wasm"),
);
if (quickjsGuest.subarray(0, 4).toString("hex") !== "0061736d") {
  fail("QuickJS guest must be a WebAssembly binary");
}

for (const dependency of piProvided) {
  if (packageJson.peerDependencies?.[dependency] !== "*") {
    fail(`${dependency} must be declared as a '*' peer dependency`);
  }
  if (packageJson.dependencies?.[dependency] !== undefined) {
    fail(`${dependency} must not be bundled as a runtime dependency`);
  }
  if (packageJson.devDependencies?.[dependency] === undefined) {
    fail(`${dependency} must remain a development dependency`);
  }
}

if (!packageJson.keywords?.includes("pi-package")) {
  fail("keywords must include 'pi-package'");
}

process.stdout.write(
  `Verified Git-installable Pi package ${packageJson.name}@${packageJson.version} (${declaredExtensions.join(", ")})\n`,
);
