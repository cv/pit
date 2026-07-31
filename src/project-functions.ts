import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  CONFIG_DIR_NAME,
  type ExtensionContext,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import {
  getProjectFunctionMetadata,
  getSavedFunctionCallSignature,
  type ProjectFunctionMetadata,
  resolveSavedFunctionReferences,
  validateTypeScript,
} from "./sandbox.js";
import {
  type FunctionRegistry,
  validateEffectiveRegistryCapacity,
  validateSavedFunctionName,
  validateSavedFunctionSource,
} from "./saved-functions.js";

const MAX_PROJECT_CATALOG_BYTES = 12_000;
const MAX_PROJECT_FUNCTIONS = 64;
const PROJECT_FUNCTION_DIRECTORY = ["pit", "functions"] as const;

export type ProjectFunctionMetadataRegistry = Map<string, ProjectFunctionMetadata>;

export interface ProjectFunctionConfig {
  enabled: boolean;
  error?: string;
}

function directory(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, ...PROJECT_FUNCTION_DIRECTORY);
}

function configPath(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, "pit.json");
}

function pathFor(cwd: string, name: string): string {
  validateSavedFunctionName(name);
  return join(directory(cwd), `${name}.ts`);
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

export async function loadProjectFunctionConfig(
  ctx: ExtensionContext,
): Promise<ProjectFunctionConfig> {
  if (!ctx.isProjectTrusted()) {
    return { enabled: false };
  }
  let source: string;
  try {
    source = await readFile(configPath(ctx.cwd), "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return { enabled: false };
    }
    throw error;
  }
  try {
    const config = JSON.parse(source) as unknown;
    if (!(config && typeof config === "object" && !Array.isArray(config))) {
      throw new Error("configuration must be a JSON object");
    }
    const projectFunctions = (config as Record<string, unknown>).projectFunctions;
    if (projectFunctions === undefined) {
      return { enabled: false };
    }
    if (
      !(
        projectFunctions &&
        typeof projectFunctions === "object" &&
        !Array.isArray(projectFunctions)
      )
    ) {
      throw new Error("projectFunctions must be an object");
    }
    const enabled = (projectFunctions as Record<string, unknown>).enabled;
    if (enabled === undefined) {
      return { enabled: false };
    }
    if (typeof enabled !== "boolean") {
      throw new Error("projectFunctions.enabled must be a boolean");
    }
    return { enabled };
  } catch (error) {
    return {
      enabled: false,
      error: `Invalid ${CONFIG_DIR_NAME}/pit.json: ${(error as Error).message}`,
    };
  }
}

export async function saveProjectFunction(
  cwd: string,
  name: string,
  source: string,
  registry: FunctionRegistry,
): Promise<boolean> {
  validateSavedFunctionSource(source);
  const candidates = new Map(registry);
  candidates.set(name, source);
  validateTypeScript(source, candidates);
  const replaced = registry.has(name);
  const path = pathFor(cwd, name);
  await withFileMutationQueue(path, async () => {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(temporary, source + (source.endsWith("\n") ? "" : "\n"), "utf8");
      await rename(temporary, path);
    } catch (error) {
      try {
        await rm(temporary, { force: true });
      } catch {
        // Preserve the original write failure when best-effort cleanup also fails.
      }
      throw error;
    }
  });
  registry.set(name, source);
  return replaced;
}

export function removeProjectFunction(cwd: string, name: string): Promise<boolean> {
  const path = pathFor(cwd, name);
  return withFileMutationQueue(path, async () => {
    try {
      await rm(path);
      return true;
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return false;
      }
      throw error;
    }
  });
}

export async function loadProjectFunctions(
  ctx: ExtensionContext,
  registry: FunctionRegistry,
  metadata: ProjectFunctionMetadataRegistry,
): Promise<string[]> {
  registry.clear();
  metadata.clear();
  if (!ctx.isProjectTrusted()) {
    return [];
  }

  let entries: Dirent[];
  try {
    entries = await readdir(directory(ctx.cwd), { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return [];
    }
    throw error;
  }

  const errors: string[] = [];
  const candidates = new Map<string, { source: string; metadata: ProjectFunctionMetadata }>();
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!(entry.isFile() && entry.name.endsWith(".ts"))) {
      continue;
    }
    try {
      const source = await readFile(join(directory(ctx.cwd), entry.name), "utf8");
      const parsed = getProjectFunctionMetadata(source);
      if (!parsed) {
        throw new Error("missing @pit project JSDoc marker");
      }
      validateSavedFunctionName(parsed.name);
      if (entry.name !== `${parsed.name}.ts`) {
        throw new Error(`filename must be ${parsed.name}.ts`);
      }
      validateSavedFunctionSource(source);
      candidates.set(parsed.name, { source, metadata: parsed });
    } catch (error) {
      errors.push(`${entry.name}: ${(error as Error).message}`);
    }
  }

  const sources = new Map([...candidates].map(([name, value]) => [name, value.source]));
  for (const [name, value] of candidates) {
    try {
      const dependencies = new Map(
        resolveSavedFunctionReferences(value.source, sources).map((reference) => [
          reference.name,
          reference.source,
        ]),
      );
      dependencies.set(name, value.source);
      validateTypeScript(value.source, dependencies);
      registry.set(name, value.source);
      metadata.set(name, value.metadata);
    } catch (error) {
      errors.push(`${name}.ts: ${(error as Error).message}`);
    }
  }
  let removedInvalidDependency = true;
  while (removedInvalidDependency) {
    removedInvalidDependency = false;
    for (const [name, source] of [...registry]) {
      try {
        validateTypeScript(source, registry);
      } catch (error) {
        registry.delete(name);
        metadata.delete(name);
        errors.push(`${name}.ts: ${(error as Error).message}`);
        removedInvalidDependency = true;
      }
    }
  }

  return errors;
}

export function reconcileProjectFunctionsForSession(
  candidates: ReadonlyMap<string, string>,
  candidateMetadata: ReadonlyMap<string, ProjectFunctionMetadata>,
  session: FunctionRegistry,
  registry: FunctionRegistry,
  metadata: ProjectFunctionMetadataRegistry,
): string[] {
  const sessionCandidates = new Map(session);
  session.clear();
  registry.clear();
  metadata.clear();
  const errors: string[] = [];

  const projectClosure = (
    roots: readonly string[],
    sessionFunctions: ReadonlyMap<string, string>,
    forceRoots = false,
  ): string[] => {
    const ordered: string[] = [];
    const selected = new Set<string>();
    const visiting = new Set<string>();
    const visit = (name: string, force: boolean): void => {
      if ((!force && sessionFunctions.has(name)) || registry.has(name) || selected.has(name)) {
        return;
      }
      const source = candidates.get(name);
      if (source === undefined) {
        throw new Error(`required project function "${name}" is unavailable`);
      }
      if (visiting.has(name)) {
        return;
      }
      visiting.add(name);
      const references = resolveSavedFunctionReferences(source, candidates)
        .filter((reference) => reference.direct)
        .map((reference) => reference.name)
        .sort((a, b) => a.localeCompare(b));
      for (const dependency of references) {
        visit(dependency, false);
      }
      visiting.delete(name);
      selected.add(name);
      ordered.push(name);
    };
    for (const root of [...roots].sort((a, b) => a.localeCompare(b))) {
      visit(root, forceRoots);
    }
    return ordered;
  };

  const proposedEffective = (
    additions: readonly string[],
    sessionFunctions: ReadonlyMap<string, string>,
  ): FunctionRegistry => {
    const project = new Map(registry);
    for (const name of additions) {
      project.set(name, candidates.get(name) as string);
    }
    return new Map([...project, ...sessionFunctions]);
  };

  const commitProjects = (names: readonly string[]): void => {
    for (const name of names) {
      registry.set(name, candidates.get(name) as string);
      const parsed = candidateMetadata.get(name);
      if (parsed) {
        metadata.set(name, parsed);
      }
    }
  };

  for (const [name, source] of sessionCandidates) {
    try {
      const proposedSession = new Map(session);
      proposedSession.set(name, source);
      const availableCandidates = new Map([...candidates, ...sessionCandidates]);
      const roots = resolveSavedFunctionReferences(source, availableCandidates)
        .filter(
          (reference) =>
            reference.direct &&
            !proposedSession.has(reference.name) &&
            candidates.has(reference.name),
        )
        .map((reference) => reference.name);
      const additions = projectClosure(roots, proposedSession);
      const effective = proposedEffective(additions, proposedSession);
      validateEffectiveRegistryCapacity(effective);
      validateTypeScript(source, effective);
      commitProjects(additions);
      session.set(name, source);
    } catch (error) {
      errors.push(`session function ${name}: ${(error as Error).message}`);
    }
  }

  for (const name of candidates.keys()) {
    if (registry.has(name)) {
      continue;
    }
    try {
      const additions = projectClosure([name], session, true);
      validateEffectiveRegistryCapacity(proposedEffective(additions, session));
      commitProjects(additions);
    } catch (error) {
      errors.push(`${name}.ts: ${(error as Error).message}`);
    }
  }
  return errors;
}

export function projectFunctionCatalog(
  metadata: ReadonlyMap<string, ProjectFunctionMetadata>,
  sessionFunctions: ReadonlyMap<string, string> = new Map(),
): string {
  if (metadata.size === 0) {
    return "";
  }
  const lines = [
    "## Project TypeScript functions",
    "",
    "These project-persisted functions are available as lexical bindings in the typescript tool:",
  ];
  const entries = [...metadata.values()].sort((a, b) => a.name.localeCompare(b.name));
  let shown = 0;
  for (const entry of entries) {
    /* v8 ignore next -- defensive bound for unusually large project catalogs */
    if (shown >= MAX_PROJECT_FUNCTIONS) {
      break;
    }
    const isSessionOverride = sessionFunctions.has(entry.name);
    const effectiveSignature = isSessionOverride
      ? getSavedFunctionCallSignature(sessionFunctions.get(entry.name) ?? "")
      : entry.signature;
    const addition = isSessionOverride
      ? [`- ${effectiveSignature ?? entry.name} — Session override of project function.`]
      : [`- ${entry.signature} — ${entry.summary.replace(/\s+/g, " ").trim()}`];
    const parameters = isSessionOverride ? [] : entry.parameters;
    for (const parameter of parameters) {
      const description = parameter.description
        ? `: ${parameter.description.replace(/\s+/g, " ").trim()}`
        : "";
      addition.push(`  - ${parameter.name}${description}`);
    }
    if (Buffer.byteLength([...lines, ...addition].join("\n")) > MAX_PROJECT_CATALOG_BYTES) {
      break;
    }
    lines.push(...addition);
    shown++;
  }
  if (shown < entries.length) {
    lines.push(
      `- … ${entries.length - shown} more; use functions.list() for the complete catalog.`,
    );
  }
  lines.push("", "Invoke them directly, for example: runTests({ coverage: true }).");
  return lines.join("\n");
}
