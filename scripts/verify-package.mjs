import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const packageLock = JSON.parse(await readFile(resolve(root, "package-lock.json"), "utf8"));

const readme = await readFile(resolve(root, "README.md"), "utf8");
const piProvided = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"];
// Pit supports only the Pi version it pins, so its peer range for Pi's own packages matches the
// development range. Pi ignores peer ranges when it installs packages, so the range documents the
// requirement rather than enforcing it.
const pinnedPiPackages = new Set(["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]);
const requiredRuntimeFiles = [
  "src/index.ts",
  "src/sandbox/run.ts",
  "src/sandbox/codemode-executor.ts",
  "src/generated/global-contract.d.ts",
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
if (!readme.includes(`pi install ${installReference}`)) {
  fail(`README.md must show pi install ${installReference} as the pinned install example`);
}
if (!/^pi install git:github\.com\/cv\/pit$/m.test(readme)) {
  fail("README.md must show the unpinned pi install git:github.com/cv/pit command");
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

for (const dependency of piProvided) {
  const peerRange = pinnedPiPackages.has(dependency)
    ? packageJson.devDependencies?.[dependency]
    : "*";
  if (packageJson.peerDependencies?.[dependency] !== peerRange) {
    fail(`${dependency} must be declared as a '${peerRange}' peer dependency`);
  }
  if (packageJson.dependencies?.[dependency] !== undefined) {
    fail(`${dependency} must not be bundled as a runtime dependency`);
  }
  if (packageJson.devDependencies?.[dependency] === undefined) {
    fail(`${dependency} must remain a development dependency`);
  }
}

// Pit runs inside Pi, so every package it shares with the pinned Pi must be the exact version
// that Pi requires: Pi provides the runtime copy, and tests on another version prove nothing.
const piAgentName = "@earendil-works/pi-coding-agent";
const lockedPiAgent = packageLock.packages?.[`node_modules/${piAgentName}`];
if (lockedPiAgent?.version !== packageJson.devDependencies?.[piAgentName]) {
  fail(
    `package-lock.json must lock ${piAgentName} ${packageJson.devDependencies?.[piAgentName]}, not ${lockedPiAgent?.version}`,
  );
}
for (const [dependency, piRequirement] of Object.entries(lockedPiAgent.dependencies ?? {})) {
  for (const field of ["dependencies", "devDependencies"]) {
    const declared = packageJson[field]?.[dependency];
    if (declared !== undefined && declared !== piRequirement) {
      fail(
        `${field}.${dependency} must be ${piRequirement}, the version ${piAgentName} ${lockedPiAgent.version} requires, not ${declared}`,
      );
    }
  }
}

if (!packageJson.keywords?.includes("pi-package")) {
  fail("keywords must include 'pi-package'");
}

process.stdout.write(
  `Verified Git-installable Pi package ${packageJson.name}@${packageJson.version} (${declaredExtensions.join(", ")})\n`,
);
