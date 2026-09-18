import { afterEach, describe, expect, it, vi } from "vitest";

import { globalFunctionDefinitions } from "../../src/functions/definitions.js";
import { FunctionInspector } from "../../src/functions/inspection.js";

afterEach(() => vi.unstubAllEnvs());

describe("layered function inspection", () => {
  it("lists and inspects real immutable native globals without inventing source", () => {
    const inspector = new FunctionInspector({}, "/project");
    const globals = inspector.list({ scope: "global", limit: 200 });
    expect(globals.total).toBe(globalFunctionDefinitions().length);
    expect(
      globals.functions.every(
        (entry) => entry.scope === "global" && entry.readOnly && entry.kind === "native",
      ),
    ).toBe(true);
    const read = inspector.inspect("workspace.read");
    expect(read).toMatchObject({
      name: "workspace.read",
      scope: "global",
      kind: "native",
      effective: true,
      available: true,
      readOnly: true,
      sealed: false,
      origin: "<pit builtin>",
      directDependencies: [],
      directEffects: ["workspace.read"],
      effects: ["workspace.read"],
    });
    expect(read.signature).toContain("workspace.read(");
    expect(read.signature).toContain("file: string");
    expect(read.documentation).toContain("workspace.read");
    expect(read).not.toHaveProperty("source");
    expect(read).not.toHaveProperty("handler");
    expect(inspector.inspect("functions.promote")).toMatchObject({ sealed: true, readOnly: true });
  });

  it("shows effective and shadowed definitions with next targets and exact effect closure", () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/agent");
    const user = "async function get({ $next }) { return $next(); }";
    const project =
      "async function get({ $next, http: { request } }) { void request; return $next(); }";
    const session =
      "async function get({ $next, workspace: { read } }) { void read; return $next(); }";
    const inspector = new FunctionInspector(
      {
        user: new Map([["context.get", user]]),
        project: new Map([["context.get", project]]),
        session: new Map([["context.get", session]]),
      },
      "/project",
    );
    const effective = inspector.inspect("context.get");
    expect(effective).toMatchObject({
      scope: "session",
      readOnly: false,
      source: session,
      directDependencies: ["workspace.read"],
      next: { name: "context.get", scope: "project" },
      directEffects: [],
      effects: ["context.get", "http.request", "workspace.read"],
    });
    expect(effective.overrideChain.map((entry) => entry.scope)).toEqual([
      "session",
      "project",
      "user",
      "global",
    ]);
    expect(effective.overrideChain.map((entry) => entry.effective)).toEqual([
      true,
      false,
      false,
      false,
    ]);
    expect(effective.overrideChain.map((entry) => entry.origin)).toEqual([
      "<active session branch>",
      "/project/.pi/functions/context/get.ts",
      "/agent/functions/context/get.ts",
      "<pit builtin>",
    ]);
    expect(inspector.inspect("context.get", "user")).toMatchObject({
      scope: "user",
      effective: false,
      effectiveScope: "session",
      source: user,
      effects: ["context.get"],
      next: { scope: "global" },
    });
    expect(inspector.list({ scope: "user" }).functions).toEqual([
      expect.objectContaining({ name: "context.get", effective: false }),
    ]);
    expect(
      inspector
        .list({ allDefinitions: true, limit: 200 })
        .functions.filter((entry) => entry.name === "context.get"),
    ).toHaveLength(4);
  });

  it("resolves ordinary dependencies virtually and attributes direct dependents to the chosen definition", () => {
    const inspector = new FunctionInspector(
      {
        user: new Map([
          ["service.read", "/** Read. */ async function read({}) { return 1; }"],
          [
            "consumer",
            "/** Consume. */ async function consumer({ service: { read } }) { return read(); }",
          ],
        ]),
        project: new Map([
          ["service.read", "/** Project read. */ async function read({}) { return 2; }"],
        ]),
      },
      "/project",
    );
    expect(inspector.inspect("consumer")).toMatchObject({
      resolvedDependencies: [{ name: "service.read", scope: "project", available: true }],
      effects: [],
    });
    expect(inspector.inspect("service.read", "project").directDependents).toEqual(["consumer"]);
    expect(inspector.inspect("service.read", "user").directDependents).toEqual([]);
  });

  it("reports invalid definitions without pretending a fallback is effective", () => {
    const inspector = new FunctionInspector(
      {
        invalidUser: new Map([
          ["workspace.read", "workspace/read.ts: broken source"],
          ["bad name", "invalid filename"],
        ]),
      },
      "/project",
    );
    expect(inspector.inspect("workspace.read")).toMatchObject({
      scope: "user",
      kind: "invalid",
      effective: true,
      available: false,
      readOnly: true,
      error: "workspace/read.ts: broken source",
    });
    expect(inspector.inspect("workspace.read", "global")).toMatchObject({
      kind: "native",
      effective: false,
      available: true,
    });
    expect(inspector.inspect("bad name", "user").origin).toBe("<invalid user definition>");
  });

  it("keeps sealed globals effective while exposing rejected override attempts", () => {
    const inspector = new FunctionInspector(
      { invalidProject: new Map([["functions.listAll", "sealed override rejected"]]) },
      "/project",
    );
    expect(inspector.inspect("functions.listAll")).toMatchObject({
      kind: "native",
      scope: "global",
      effective: true,
      available: true,
      sealed: true,
    });
    expect(inspector.inspect("functions.listAll", "project")).toMatchObject({
      kind: "invalid",
      effective: false,
      available: false,
    });
  });

  it("explains missing dependencies and never evaluates source during inspection", () => {
    const source = 'async function broken({ missing }) { throw new Error("must not execute"); }';
    const inspector = new FunctionInspector({ session: new Map([["broken", source]]) }, "/project");
    const inspected = inspector.inspect("broken");
    expect(inspected).toMatchObject({
      kind: "source",
      source,
      available: false,
      effects: [],
      resolvedDependencies: [{ name: "missing", available: false }],
    });
    expect(inspected.error).toContain('requires unavailable dependency "missing"');
    expect(inspector.list({ scope: "session" }).functions[0]?.available).toBe(false);
  });

  it("paginates deterministically and bounds long listing signatures", () => {
    const inspector = new FunctionInspector(
      {
        session: new Map([
          [
            "large",
            `async function large({}, input: { value: "${"x".repeat(2000)}" }) { return input; }`,
          ],
        ]),
      },
      "/project",
    );
    const first = inspector.list({ limit: 2 });
    const second = inspector.list({ offset: first.nextOffset ?? 0, limit: 2 });
    expect(first.functions).toHaveLength(2);
    expect(first.nextOffset).toBe(2);
    expect(second.offset).toBe(2);
    expect(second.functions[0]?.name).not.toBe(first.functions[0]?.name);
    expect(inspector.list({ offset: first.total, limit: 2 })).toEqual({
      functions: [],
      offset: first.total,
      total: first.total,
    });
    expect(inspector.list({ scope: "session" }).functions[0]?.signature.length).toBe(1000);
    expect(inspector.inspect("large").signature.length).toBeGreaterThan(1000);
  });

  it.each([
    { name: "negative offset", options: { offset: -1 } },
    { name: "fractional offset", options: { offset: 0.5 } },
    { name: "zero limit", options: { limit: 0 } },
    { name: "oversized limit", options: { limit: 201 } },
    { name: "non-finite limit", options: { limit: Infinity } },
  ])("rejects $name", ({ options }) => {
    expect(() => new FunctionInspector({}, "/project").list(options)).toThrow(
      "offset must be non-negative",
    );
  });

  it("rejects missing definitions and missing explicit scopes", () => {
    const inspector = new FunctionInspector({}, "/project");
    expect(() => inspector.inspect("missing")).toThrow('function "missing" is unavailable');
    expect(() => inspector.inspect("workspace.read", "session")).toThrow(
      'Session function "workspace.read" is unavailable',
    );
  });

  it("reports positional, rest, and generic public signatures without the dependency parameter", () => {
    const source =
      "async function collect<T extends string>({}, first: T, ...rest: T[]): Promise<T[]> { return [first, ...rest]; }";
    const inspector = new FunctionInspector(
      { session: new Map([["company.collect", source]]) },
      "/project",
    );
    expect(inspector.inspect("company.collect").signature).toBe(
      "company.collect<T extends string>(first: T, ...rest: T[]): Promise<T[]>",
    );
  });

  it("labels anonymous source-backed implementations without inventing a declaration signature", () => {
    const inspector = new FunctionInspector(
      { session: new Map([["anonymous", "async ({}) => 1"]]) },
      "/project",
    );
    expect(inspector.inspect("anonymous")).toMatchObject({
      kind: "source",
      signature: "anonymous(…)",
      source: "async ({}) => 1",
    });
  });
});
