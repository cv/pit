import { join, sep } from "node:path";

const FUNCTION_SEGMENT = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
const MAX_FUNCTION_ID_LENGTH = 255;
const RESERVED_SEGMENTS = new Set(["$next", "__proto__", "constructor", "prototype"]);

export function validateFunctionId(id: string): void {
  const segments = id.split(".");
  if (
    id.length === 0 ||
    id.length > MAX_FUNCTION_ID_LENGTH ||
    segments.some((segment) => !FUNCTION_SEGMENT.test(segment) || RESERVED_SEGMENTS.has(segment))
  ) {
    throw new Error(
      "function identifier must contain non-reserved TypeScript identifiers separated by dots",
    );
  }
}

export function functionIdSegments(id: string): string[] {
  validateFunctionId(id);
  return id.split(".");
}

export function functionRelativePath(id: string): string {
  const segments = functionIdSegments(id);
  const name = segments.pop() as string;
  return join(...segments, `${name}.ts`);
}

export function functionIdFromRelativePath(path: string): string {
  const normalized = path.split(sep).join("/");
  if (
    normalized.startsWith("/") ||
    !normalized.endsWith(".ts") ||
    normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("function path must be a relative TypeScript file path");
  }
  const id = normalized.slice(0, -3).split("/").join(".");
  validateFunctionId(id);
  return id;
}

export function validateFunctionNamespaces(ids: Iterable<string>): void {
  const leaves = new Set<string>();
  for (const id of ids) {
    validateFunctionId(id);
    leaves.add(id);
  }
  for (const id of leaves) {
    const segments = id.split(".");
    for (let length = 1; length < segments.length; length++) {
      const namespace = segments.slice(0, length).join(".");
      if (leaves.has(namespace)) {
        throw new Error(`function namespace conflict: "${namespace}" and "${id}"`);
      }
    }
  }
}
