/** Read-only comparison of direct dependency requirements, package-lock v2/v3 metadata, and installed versions. Reports missing or mismatched packages with bounded fields and explicit omissions; never installs packages or claims semver/content verification. */
async function inspectPitDependencyInstall(
  { shell: { execFile } },
  input: { packages?: string[]; limit?: number } = {},
) {
  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 30)
    throw new Error("limit must be an integer between 1 and 30");
  const packages = input.packages === undefined ? undefined : [...new Set(input.packages)];
  const packagePattern = "^(?:@[a-z0-9][a-z0-9._-]*[/])?[a-z0-9][a-z0-9._-]*$";
  const validName = (name: string) =>
    name.length <= 214 && new RegExp(packagePattern, "i").test(name);
  if (
    packages &&
    (packages.length === 0 || packages.length > 30 || packages.some((name) => !validName(name)))
  )
    throw new Error("packages must contain 1-30 valid npm package names");
  const script = `
import fs from "node:fs";
const input = JSON.parse(process.argv[1]);
const clip = text => String(text).slice(0, 250);
function readJson(file) {
  try {
    if (fs.statSync(file).size > 2000000) throw new Error("JSON file exceeds 2 MB inspection limit");
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object");
    return { value, error: null, missing: false };
  } catch (error) {
    return { value: null, error: clip(error.message), missing: error.code === "ENOENT" };
  }
}
const manifest = readJson("package.json");
if (!manifest.value) throw new Error("Cannot inspect package.json: " + manifest.error);
const lock = readJson("package-lock.json");
const supported = [2, 3].includes(lock.value?.lockfileVersion) && !!lock.value?.packages;
const declarations = value => ({ ...(value?.dependencies ?? {}), ...(value?.devDependencies ?? {}), ...(value?.optionalDependencies ?? {}) });
const declared = declarations(manifest.value);
const lockedDeclared = declarations(supported ? lock.value.packages[""] : undefined);
const names = input.packages ?? Object.keys(declared).sort();
const chosen = names.slice(0, input.limit);
const validName = name => name.length <= 214 && new RegExp(${JSON.stringify(packagePattern)}, "i").test(name);
const text = value => typeof value === "string" ? clip(value) : null;
const dependencies = chosen.map(name => {
  if (!validName(name)) throw new Error("Manifest contains an invalid package name");
  const installed = readJson("node_modules/" + name + "/package.json");
  const entry = supported ? lock.value.packages["node_modules/" + name] : undefined;
  const issues = [];
  if (typeof declared[name] !== "string") issues.push("not-declared");
  if (!supported) issues.push("lock-unavailable-or-unsupported");
  else {
    if (lockedDeclared[name] !== declared[name]) issues.push("manifest-lock-mismatch");
    if (typeof entry?.version !== "string") issues.push("no-locked-version");
  }
  if (!installed.value) issues.push(installed.missing ? "not-installed" : "installed-metadata-unreadable");
  else if (typeof installed.value.version !== "string") issues.push("no-installed-version");
  else if (typeof entry?.version === "string" && installed.value.version !== entry.version) issues.push("installed-version-mismatch");
  return {
    name, declared: text(declared[name]), lockedRequirement: text(lockedDeclared[name]),
    lockedVersion: text(entry?.version), installedVersion: text(installed.value?.version),
    optional: Object.hasOwn(manifest.value.optionalDependencies ?? {}, name),
    matchesLock: supported ? issues.length === 0 : null,
    fieldsTruncated: [declared[name], lockedDeclared[name], entry?.version, installed.value?.version].some(value => typeof value === "string" && value.length > 250),
    issues, ...(installed.error ? { error: installed.error } : {}),
  };
});
const omitted = names.length - chosen.length;
console.log(JSON.stringify({
  total: names.length, inspected: chosen.length, omitted, complete: omitted === 0,
  matchesLock: omitted || !supported ? null : dependencies.every(item => item.matchesLock === true),
  lockfileVersion: typeof lock.value?.lockfileVersion === "number" ? lock.value.lockfileVersion : null,
  lockError: lock.error ?? (supported ? null : "Requires package-lock.json version 2 or 3"),
  scope: "Direct dependencies only; compares lock metadata and versions, not package contents or semver compatibility. Optional packages may legitimately be absent.",
  dependencies,
}));
`;
  const result = await execFile(
    "node",
    ["--input-type=module", "-e", script, JSON.stringify({ packages, limit })],
    { raise: false, timeoutMs: 15000, maxBytes: 45000, maxLines: 30, truncate: "head" },
  );
  if (result.code !== 0)
    throw new Error(
      `Dependency inspection failed (exit ${result.code}): ${result.stderr.slice(0, 1800)}`,
    );
  if (result.truncated)
    throw new Error("Dependency inspection output was truncated; request fewer packages");
  return JSON.parse(result.stdout) as {
    total: number;
    inspected: number;
    omitted: number;
    complete: boolean;
    matchesLock: boolean | null;
    lockfileVersion: number | null;
    lockError: string | null;
    scope: string;
    dependencies: Array<{
      name: string;
      declared: string | null;
      lockedRequirement: string | null;
      lockedVersion: string | null;
      installedVersion: string | null;
      optional: boolean;
      matchesLock: boolean | null;
      fieldsTruncated: boolean;
      issues: string[];
      error?: string;
    }>;
  };
}
