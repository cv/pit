import { describe, expect, it } from "vitest";

import { generateCapabilityContract } from "../../src/capabilities/registry.js";
import { typeDiagnostics } from "../helpers/type-contract.js";

describe("generated capability types", () => {
  it("accepts supported calls and rejects invalid inputs and result assumptions", () => {
    const consumer = `
async function accepted(c: PitCapabilities) {
  const file = await c.workspace.read("a.ts", { format: "raw" });
  const text: string = file.content;
  await c.workspace.edit("new.ts", { revision: null, changes: [{ kind: "replaceFile", content: text }] });
  await c.workspace.batch([{ kind: "read", file: "a.ts" }], { failure: "settled" });
  const process = await c.git.status(["--short"]);
  const exitCode: number = process.code;
  await c.npm.test({ coverage: true });
  await c.gh.prList({ json: ["number"], limit: 5 });
  await c.shell.execFile("node", ["--version"], { raise: true });
  const response = await c.http.request("https://example.invalid");
  const status: number = response.status;
  await c.functions.removeSession("helper", { cascade: true });
  return { text, exitCode, status };
}
async function rejected(c: PitCapabilities) {
  // @ts-expect-error a file path is required
  await c.workspace.read();
  // @ts-expect-error file paths are strings
  await c.workspace.read(42);
  // @ts-expect-error format is a supported enum, not arbitrary text
  await c.workspace.read("a.ts", { format: "yaml" });
  // @ts-expect-error edits require at least one change
  await c.workspace.edit("a.ts", { revision: null, changes: [] });
  // @ts-expect-error argv is an array of strings
  await c.git.status([1]);
  // @ts-expect-error process limits are numeric
  await c.git.status([], { maxBytes: "unbounded" });
  // @ts-expect-error GitHub output selection uses json, not fields
  await c.gh.prList({ fields: ["number"] });
  // @ts-expect-error exit codes are numbers, not strings
  const exit: string = (await c.shell.execFile("node", [])).code;
  // @ts-expect-error cascade is an explicit boolean option
  await c.functions.removeSession("helper", { cascade: "yes" });
}
`;
    expect(typeDiagnostics(generateCapabilityContract() + consumer)).toEqual([]);
  });
});
