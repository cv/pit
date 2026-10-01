import { describe, expect, it } from "vitest";

import { generateGlobalContract } from "../../src/functions/global-contract.js";
import { typeDiagnostics } from "../helpers/type-contract.js";

describe("generated global function types", () => {
  it("accepts supported calls and rejects invalid calls", () => {
    const consumer = `
async function accepted(c: PitDependencies) {
  const file = await c.workspace.read("a.ts", { format: "raw" });
  const text: string = file.content;
  await c.workspace.edit("new.ts", { revision: null, changes: [{ kind: "replaceFile", content: text }] });
  const image = await c.workspace.viewImage("chart.png");
  const mimeType: string = image.mimeType;

  const reads = await c.workspace.batch([{ kind: "read", file: "a.ts" }], { failure: "settled" });
  const readKinds: "read"[] = reads.results.map((result) => result.kind);
  const edits = await c.workspace.batch([
    { kind: "edit", file: "a.ts", changes: { revision: null, changes: [{ kind: "replaceFile", content: text }] } },
  ]);
  const editKinds: "edit"[] = edits.results.map((result) => result.kind);
  const process = await c.git.status(["--short"]);
  const exitCode: number = process.code;
  await c.npm.test({ coverage: true });
  await c.gh.prList({ json: ["number"], limit: 5 });
  await c.shell.execFile("node", ["--version"], { raise: true });
  const response = await c.http.request("https://example.invalid");
  const status: number = response.status;
  await c.functions.removeSession("helper", { cascade: true });
  const outline = await c.session.outline({ roles: ["toolResult"], tool: "bash", limit: 5 });
  const reprefill: number | undefined = outline.entries[0]?.reprefillTokens;
  const inspected = await c.session.inspectEntry("a1b2c3d4", { offset: 0, limit: 100 });
  const originalText: string = inspected.original.text;
  const elided = await c.session.elide(["a1b2c3d4"], { reason: "stale log" });
  const freed: number = elided.estimatedTokensFreed;
  const action: "created" | "replaced" | "removed" = (await c.session.setNote("progress", "v1")).action;
  await c.session.setNote("progress", null);
  const budget: number = (await c.session.notes()).budgetTokens;
  const summarized: number = (
    await c.session.summarize({ from: "a1b2c3d4", to: "b2c3d4e5", summary: "Tried X." })
  ).summarizedEntries;
  return { text, exitCode, status, readKinds, editKinds };
}

async function rejected(c: PitDependencies) {
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
  // @ts-expect-error failure handling applies only to read batches
  await c.workspace.batch([{ kind: "edit", file: "a.ts", changes: { revision: null, changes: [{ kind: "replaceFile", content: "x" }] } }], { failure: "settled" });
  // @ts-expect-error workspace images require a file path
  await c.workspace.viewImage();
  // @ts-expect-error workspace image paths are strings
  await c.workspace.viewImage(42);
  // @ts-expect-error outline roles are model-context roles, not prompt roles
  await c.session.outline({ roles: ["system"] });
  // @ts-expect-error an entry ID is required
  await c.session.inspectEntry();
  // @ts-expect-error elide takes an array of entry IDs
  await c.session.elide("a1b2c3d4");
  // @ts-expect-error receipts report staged edits, not applied ones
  const applied: "applied" = (await c.session.elide(["a1b2c3d4"])).status;
  // @ts-expect-error removing a note passes null explicitly
  await c.session.setNote("progress");
  // @ts-expect-error a summary needs a range and its text
  await c.session.summarize({ from: "a1b2c3d4" });

}
`;
    expect(typeDiagnostics(generateGlobalContract() + consumer)).toEqual([]);
  });
});
