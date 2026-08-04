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
  getSavedFunctionDependencyGraph,
  type ProjectFunctionMetadata,
  validateTypeScript,
} from "./sandbox.js";
import {
  type FunctionRegistry,
  validateSavedFunctionName,
  validateSavedFunctionSource,
} from "./saved-functions.js";

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
  const sourceGraph = getSavedFunctionDependencyGraph(sources);
  for (const [name, value] of candidates) {
    try {
      const dependencies = new Map(
        sourceGraph.resolve(value.source).map((reference) => [reference.name, reference.source]),
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
