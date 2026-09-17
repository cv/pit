import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  functionIdFromRelativePath,
  functionIdSegments,
  functionRelativePath,
  validateFunctionId,
  validateFunctionNamespaces,
} from "../../src/functions/identifier.js";

describe("function identifiers", () => {
  it.each([
    { id: "validatePit", segments: ["validatePit"], path: "validatePit.ts" },
    { id: "workspace.read", segments: ["workspace", "read"], path: join("workspace", "read.ts") },
    { id: "$private.value", segments: ["$private", "value"], path: join("$private", "value.ts") },
  ])("maps $id to a namespaced path", ({ id, segments, path }) => {
    expect(functionIdSegments(id)).toEqual(segments);
    expect(functionRelativePath(id)).toBe(path);
    expect(functionIdFromRelativePath(path)).toBe(id);
  });

  it.each([
    "",
    ".read",
    "workspace.",
    "workspace..read",
    "workspace.read-value",
    "workspace.1read",
    "workspace.$next",
    "workspace.__proto__",
    "constructor",
    "prototype.value",
    "a".repeat(256),
  ])("rejects invalid identifier %j", (id) => {
    expect(() => validateFunctionId(id)).toThrow("function identifier");
  });

  it.each(["/absolute/read.ts", "../read.ts", "workspace/read.js", "workspace//read.ts"])(
    "rejects invalid relative path %j",
    (path) => {
      expect(() => functionIdFromRelativePath(path)).toThrow("relative TypeScript file path");
    },
  );

  it("rejects leaf and namespace conflicts", () => {
    expect(() => validateFunctionNamespaces(["workspace", "workspace.read"])).toThrow(
      'function namespace conflict: "workspace" and "workspace.read"',
    );
    expect(() =>
      validateFunctionNamespaces(["workspace.read", "workspace.edit", "validatePit"]),
    ).not.toThrow();
  });
});
