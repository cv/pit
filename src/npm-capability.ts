import type { CAPABILITY_METHODS } from "./capability-registry.js";

type NpmMethod = (typeof CAPABILITY_METHODS)["npm"][number];

export interface PreparedNpmCommand {
  args: string[];
  options: Record<string, unknown>;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!(Array.isArray(value) && value.every((entry) => typeof entry === "string"))) {
    throw new TypeError(`${label} must be an array of strings`);
  }
  return value;
}

function boolean(value: unknown, label: string, defaultValue = false): boolean {
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value !== "boolean") {
    throw new TypeError(`${label} must be a boolean`);
  }
  return value;
}

function processOptions(value: unknown, specialKeys: string[] = []): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  const options = { ...object(value, "options") };
  for (const key of specialKeys) {
    delete options[key];
  }
  return options;
}

function extraArgs(value: unknown): string[] {
  return value === undefined ? [] : stringArray(value, "options.args");
}

export function prepareNpmCommand(method: NpmMethod, args: unknown[]): PreparedNpmCommand {
  switch (method) {
    case "run": {
      const script = string(args[0], "script");
      const scriptArgs = args[1] === undefined ? [] : stringArray(args[1], "args");
      return {
        args: ["run", script, ...(scriptArgs.length > 0 ? ["--", ...scriptArgs] : [])],
        options: processOptions(args[2]),
      };
    }
    case "test": {
      const raw = args[0] === undefined ? {} : object(args[0], "options");
      const coverage = boolean(raw.coverage, "options.coverage");
      const testArgs = extraArgs(raw.args);
      return {
        args: [
          "run",
          coverage ? "coverage" : "test",
          ...(testArgs.length > 0 ? ["--", ...testArgs] : []),
        ],
        options: processOptions(raw, ["coverage", "args"]),
      };
    }
    case "install": {
      const packages = args[0] === undefined ? [] : stringArray(args[0], "packages");
      const raw = args[1] === undefined ? {} : object(args[1], "options");
      const flags = [
        boolean(raw.dev, "options.dev") ? "--save-dev" : "",
        boolean(raw.exact, "options.exact") ? "--save-exact" : "",
        boolean(raw.packageLockOnly, "options.packageLockOnly") ? "--package-lock-only" : "",
        boolean(raw.ignoreScripts, "options.ignoreScripts") ? "--ignore-scripts" : "",
      ].filter(Boolean);
      return {
        args: ["install", ...flags, ...packages],
        options: processOptions(raw, ["dev", "exact", "packageLockOnly", "ignoreScripts"]),
      };
    }
    case "audit": {
      const raw = args[0] === undefined ? {} : object(args[0], "options");
      return {
        args: [
          "audit",
          "--json",
          ...(boolean(raw.omitDev, "options.omitDev") ? ["--omit=dev"] : []),
        ],
        options: processOptions(raw, ["omitDev"]),
      };
    }
    case "outdated":
      return { args: ["outdated", "--json"], options: processOptions(args[0]) };
    case "pack": {
      const raw = args[0] === undefined ? {} : object(args[0], "options");
      const dryRun = boolean(raw.dryRun, "options.dryRun", true);
      return {
        args: ["pack", "--json", ...(dryRun ? ["--dry-run"] : [])],
        options: processOptions(raw, ["dryRun"]),
      };
    }
    default:
      throw new Error(`Unknown npm method: ${method}`);
  }
}
