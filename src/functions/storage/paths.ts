import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

/** Where saved functions load from and are written to, resolved for one session. */
export interface FunctionPaths {
  project: string;
  user: string;
}

/** `paths` as written in `.pi/pit.json`: each entry optional. */
export type ConfiguredFunctionPaths = Partial<FunctionPaths>;

/** The project default: `.pi/functions` in the project root. */
export function defaultProjectFunctionDirectory(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, "functions");
}

/** The user default: `functions` in Pi's agent directory, usually `~/.pi/agent/functions`. */
export function defaultUserFunctionDirectory(): string {
  return join(getAgentDir(), "functions");
}

/**
 * A configured directory as an absolute path. `~` and `~/...` expand to the home directory;
 * other relative paths resolve against the project root. Paths may point outside the project,
 * for example to a separate repository of shared functions.
 */
export function resolveConfiguredDirectory(cwd: string, configured: string): string {
  const path = configured.trim();
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

export function resolveFunctionPaths(
  cwd: string,
  configured: ConfiguredFunctionPaths = {},
): FunctionPaths {
  return {
    project:
      configured.project === undefined
        ? defaultProjectFunctionDirectory(cwd)
        : resolveConfiguredDirectory(cwd, configured.project),
    user:
      configured.user === undefined
        ? defaultUserFunctionDirectory()
        : resolveConfiguredDirectory(cwd, configured.user),
  };
}
