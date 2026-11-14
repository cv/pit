import { defineCommandFunction } from "../command-source.js";

export const npmFunctions = [
  defineCommandFunction("npm", "run", {
    summary: "Run an npm script",
    resultRenderer: "npm.run",
    declaration:
      "run(script: string, args?: string[] | PitProcessOptions, options?: PitProcessOptions): Promise<PitProcessResult>;",
    documentation:
      "npm.run(script, args?, options?) runs a package script with argument-safe args; without args, options may come second: npm.run(script, options)",
    minimumArguments: 1,
    maximumArguments: 3,
  }),
  defineCommandFunction("npm", "test", {
    summary: "Run npm tests",
    resultRenderer: "npm.test",
    declaration: "test(options?: PitNpmTestOptions): Promise<PitProcessResult>;",
    documentation:
      "npm.test({ args?, coverage?, ...processOptions }?) runs test or coverage scripts",
    minimumArguments: 0,
    maximumArguments: 1,
  }),
  defineCommandFunction("npm", "install", {
    summary: "Install npm packages",
    resultRenderer: "npm.install",
    declaration:
      "install(packages?: string[], options?: PitNpmInstallOptions): Promise<PitProcessResult>;",
    documentation:
      "npm.install(packages?, { dev?, exact?, packageLockOnly?, ignoreScripts?, ...processOptions }?)",
    minimumArguments: 0,
    maximumArguments: 2,
  }),
  defineCommandFunction("npm", "ci", {
    summary: "Install the locked npm dependencies",
    resultRenderer: "npm.ci",
    declaration: "ci(options?: PitNpmCiOptions): Promise<PitProcessResult>;",
    documentation:
      "npm.ci({ includeDev?, ignoreScripts?, ...processOptions }?) runs npm ci; includeDev: false omits dev dependencies, true includes them even under NODE_ENV=production",
    minimumArguments: 0,
    maximumArguments: 1,
  }),
  defineCommandFunction("npm", "audit", {
    summary: "Audit npm dependencies",
    resultRenderer: "npm.audit",
    declaration: "audit(options?: PitNpmAuditOptions): Promise<PitProcessResult>;",
    documentation: "npm.audit({ omitDev?, ...processOptions }?) uses bounded JSON output",
    minimumArguments: 0,
    maximumArguments: 1,
  }),
  defineCommandFunction("npm", "outdated", {
    summary: "Inspect outdated npm packages",
    resultRenderer: "npm.outdated",
    declaration: "outdated(options?: PitProcessOptions): Promise<PitProcessResult>;",
    documentation: "npm.outdated(options?) uses bounded JSON output",
    minimumArguments: 0,
    maximumArguments: 1,
  }),
  defineCommandFunction("npm", "pack", {
    summary: "Inspect npm package contents",
    resultRenderer: "npm.pack",
    declaration: "pack(options?: PitNpmPackOptions): Promise<PitProcessResult>;",
    documentation: "npm.pack({ dryRun?: true, ...processOptions }?) defaults to a JSON dry run",
    minimumArguments: 0,
    maximumArguments: 1,
  }),
] as const;
