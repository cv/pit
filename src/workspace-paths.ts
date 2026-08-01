import { relative, resolve } from "node:path";

const AT_PATH_PREFIX = /^@/;

export function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function string(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }
  return value;
}

export function checkAbort(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

export function resolveWorkspacePath(cwd: string, value: unknown): string {
  return resolve(cwd, string(value, "path").replace(AT_PATH_PREFIX, ""));
}

export function workspaceResultPath(cwd: string, path: string): string {
  return relative(cwd, path).replaceAll("\\", "/");
}
