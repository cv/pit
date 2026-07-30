import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const piProvided = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"];
const requiredRuntimeFiles = [
  "src/index.ts",
  "src/sandbox.ts",
  "src/sandbox-runner.mjs",
  "src/capability-contract.d.ts",
];

function fail(message) {
  throw new Error(`Package verification failed: ${message}`);
}

if (!Array.isArray(packageJson.pi?.extensions) || packageJson.pi.extensions.length === 0) {
  fail("package.json must declare at least one pi.extensions entry");
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
