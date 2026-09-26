import { relative, resolve } from "node:path";

import { stringValue as string } from "../shared/argument-values.js";

const AT_PATH_PREFIX = /^@/;

export function checkAbort(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

export function resolveWorkspacePath(cwd: string, value: unknown): string {
  return resolve(cwd, string(value, "path").replace(AT_PATH_PREFIX, ""));
}

export function workspaceResultPath(cwd: string, path: string): string {
  return relative(cwd, path).replaceAll("\\", "/");
}
