import type { ToolLoadout } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cleanupHarness,
  context,
  functionsCommand,
  run,
  sessionStart,
  setupHarness,
  tool,
  value,
} from "../support/extension-fixture.js";

beforeEach(setupHarness);
afterEach(cleanupHarness);

/** Pi's MCP extension declares every MCP tool as returning this wrapper. */
function mcpResultSchema(structuredContent?: object): object {
  return {
    type: "object",
    properties: {
      content: { type: "array", items: { type: "object" } },
      ...(structuredContent ? { structuredContent } : {}),
      isError: { type: "boolean" },
      _meta: { type: "object" },
    },
    required: ["content"],
  };
}

const GRAPH_SCHEMA = {
  type: "object",
  properties: {
    entities: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          observations: { type: "array", items: { type: "string" } },
        },
        required: ["name", "observations"],
        additionalProperties: false,
      },
    },
  },
  required: ["entities"],
  additionalProperties: false,
};

const TOOLS = [
  {
    name: "mcp__github__list_issues",
    description: "List issues in a GitHub repository. Supports filtering.",
    parameters: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        labels: { type: "array", items: { type: "string" } },
      },
      required: ["owner", "repo"],
    },
    outputSchema: mcpResultSchema(),
  },
  {
    name: "mcp__memory__read_graph",
    description: "Read the entire knowledge graph.",
    parameters: { type: "object", properties: {} },
    outputSchema: mcpResultSchema(GRAPH_SCHEMA),
  },
  {
    name: "goal_complete",
    description: "Mark the current goal complete.",
    parameters: {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
    },
  },
  {
    name: "screenshot",
    description: "Capture the page.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "lookup",
    description: `Look up a principal by identifier, returning either a user or a team with its members${" and more".repeat(20)}.`,
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    outputSchema: {
      anyOf: [
        {
          type: "object",
          properties: { kind: { const: "user" }, login: { type: "string" } },
          required: ["kind", "login"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            kind: { const: "team" },
            members: { type: "array", items: { type: "string" } },
          },
          required: ["kind", "members"],
          additionalProperties: false,
        },
      ],
    },
  },
  {
    name: "labels",
    description: "List label colors by name.",
    parameters: { type: "object", properties: {} },
    outputSchema: {
      type: "object",
      additionalProperties: {
        type: "object",
        properties: { color: { type: "string" } },
        required: ["color"],
        additionalProperties: false,
      },
    },
  },
  // Excluded: Pit supersedes Pi's file and shell built-ins and never calls orchestrators.
  {
    name: "read",
    description: "Read a file.",
    parameters: { type: "object", properties: { path: { type: "string" } } },
  },
  {
    name: "codemode",
    description: "Run a script.",
    parameters: { type: "object", properties: {} },
  },
];

type Outcome = { result: Record<string, unknown>; isError: boolean };

const text = (value: string) => [{ type: "text", text: value }];

/** The context Pi passes to `typescript`: the callable tools plus `executeTool()`. */
function toolContext(outcomes: Record<string, Outcome>, tools: object[] = TOOLS) {
  const executeTool = vi.fn(async (name: string, args: unknown) => ({
    toolCall: { type: "toolCall", id: `call-id/${name}`, name, arguments: args },
    ...(outcomes[name] ?? { result: { content: text(`no outcome for ${name}`) }, isError: true }),
  }));
  return { ctx: context({ tools, executeTool }), executeTool };
}

function mcpOutcome(result: Record<string, unknown>, isError = false): Outcome {
  // Pi's MCP extension truncates the model-facing content and keeps the server's result whole.
  return {
    result: { content: text("[truncated]"), details: {}, structuredContent: result },
    isError,
  };
}

describe("Pi tools injected from tools", () => {
  it("calls an MCP tool through executeTool and returns the server's untruncated text", async () => {
    const issues = [{ number: 101, title: "Crash" }];
    const { ctx, executeTool } = toolContext({
      mcp__github__list_issues: mcpOutcome({ content: text(JSON.stringify(issues)) }),
    });
    const result = await value(
      `async ({ tools: { mcp__github__list_issues } }) => {
        const issues: Array<{ number: number }> = JSON.parse(await mcp__github__list_issues({ owner: "acme", repo: "widgets", labels: ["bug"] }));
        return issues.map((issue) => issue.number);
      }`,
      ctx,
    );
    expect(result).toEqual([101]);
    expect(executeTool).toHaveBeenCalledExactlyOnceWith(
      "mcp__github__list_issues",
      { owner: "acme", repo: "widgets", labels: ["bug"] },
      { signal: expect.any(AbortSignal) },
    );
  });

  it.each<{ name: string; code: string; outcome: Outcome; tool: string; expected: unknown }>([
    {
      name: "MCP structured content, typed and without undeclared properties",
      tool: "mcp__memory__read_graph",
      outcome: mcpOutcome({
        content: text("{}"),
        structuredContent: { entities: [{ type: "entity", name: "Dana", observations: ["lead"] }] },
      }),
      code: `async ({ tools: { mcp__memory__read_graph } }) => (await mcp__memory__read_graph()).entities.map((entity) => entity.name + ":" + entity.observations.length)`,
      expected: ["Dana:1"],
    },
    {
      name: "another extension's tool text",
      tool: "goal_complete",
      outcome: {
        result: { content: text("Goal completed."), details: { goal: 1 } },
        isError: false,
      },
      code: `async ({ tools: { goal_complete } }) => goal_complete({ summary: "done" })`,
      expected: "Goal completed.",
    },
    {
      name: "another extension's structured result, matched to a union branch",
      tool: "lookup",
      outcome: {
        result: {
          content: text("team"),
          structuredContent: { kind: "team", members: ["kim"], cached: true },
        },
        isError: false,
      },
      code: `async ({ tools: { lookup } }) => { const principal = await lookup({ id: "core" }); return principal.kind === "team" ? principal.members : [principal.login]; }`,
      expected: ["kim"],
    },
    {
      name: "a map-shaped structured result without undeclared nested properties",
      tool: "labels",
      outcome: {
        result: { content: text("labels"), structuredContent: { bug: { color: "red", id: 7 } } },
        isError: false,
      },
      code: `async ({ tools: { labels } }) => labels()`,
      expected: { bug: { color: "red" } },
    },
  ])("returns $name", async ({ code, outcome, tool: name, expected }) => {
    const { ctx } = toolContext({ [name]: outcome });
    expect(await value(code, ctx)).toEqual(expected);
  });

  it.each<{ name: string; tool: string; code: string; outcome: Outcome; error: RegExp }>([
    {
      name: "an MCP server error",
      tool: "mcp__github__list_issues",
      code: `async ({ tools: { mcp__github__list_issues } }) => mcp__github__list_issues({ owner: "acme", repo: "gone" })`,
      outcome: mcpOutcome({ content: text("Not Found: acme/gone"), isError: true }, true),
      error: /mcp__github__list_issues failed: Not Found: acme\/gone/,
    },
    {
      name: "a failed Pi tool",
      tool: "goal_complete",
      code: `async ({ tools: { goal_complete } }) => goal_complete({ summary: "done" })`,
      outcome: { result: { content: text("No active goal") }, isError: true },
      error: /goal_complete failed: No active goal/,
    },
    {
      name: "structured content that contradicts its schema, with the path",
      tool: "mcp__memory__read_graph",
      code: `async ({ tools: { mcp__memory__read_graph } }) => mcp__memory__read_graph()`,
      outcome: mcpOutcome({
        content: text("{}"),
        structuredContent: { entities: [{ name: 7, observations: [] }] },
      }),
      error:
        /mcp__memory__read_graph returned a result that does not match its output schema: \/entities\/0\/name/,
    },
    {
      name: "a root-level schema mismatch",
      tool: "labels",
      code: `async ({ tools: { labels } }) => labels()`,
      outcome: { result: { content: text("[]"), structuredContent: "none" }, isError: false },
      error: /labels returned a result that does not match its output schema: \/ must be object/,
    },
    {
      name: "a missing structured result the tool declares",
      tool: "lookup",
      code: `async ({ tools: { lookup } }) => lookup({ id: "core" })`,
      outcome: { result: { content: text("core") }, isError: false },
      error: /lookup returned no structured result despite declaring one/,
    },
    {
      name: "a failure without a message",
      tool: "goal_complete",
      code: `async ({ tools: { goal_complete } }) => goal_complete({ summary: "done" })`,
      outcome: { result: { content: [] }, isError: true },
      error: /goal_complete failed/,
    },
  ])("throws for $name", async ({ tool: name, code, outcome, error }) => {
    const { ctx } = toolContext({ [name]: outcome });
    await expect(run(code, ctx)).rejects.toThrow(error);
  });

  it.each<{ name: string; code: string; error: RegExp }>([
    {
      name: "a wrongly typed argument",
      code: `async ({ tools: { mcp__github__list_issues } }) => mcp__github__list_issues({ owner: "acme", repo: "widgets", labels: "bug" })`,
      error: /Type 'string' is not assignable to type 'string\[\]'/,
    },
    {
      name: "a missing required argument",
      code: `async ({ tools: { goal_complete } }) => goal_complete({})`,
      error: /Property 'summary' is missing/,
    },
    {
      name: "a built-in Pit supersedes",
      code: `async ({ tools: { read } }) => read({ path: "x" })`,
      error: /Property 'read' does not exist|requires unavailable function "tools.read"/,
    },
    {
      name: "an orchestrator",
      code: `async ({ tools: { codemode } }) => codemode()`,
      error: /Property 'codemode' does not exist|requires unavailable function "tools.codemode"/,
    },
  ])("rejects $name before running anything", async ({ code, error }) => {
    const { ctx, executeTool } = toolContext({});
    await expect(run(code, ctx)).rejects.toThrow(error);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it.each<{ name: string; code: string; error: string }>([
    {
      name: "arguments that are not an object",
      code: `async ({ tools: { goal_complete } }) => (goal_complete as any)("done")`,
      error: "tools.goal_complete expects an arguments object",
    },
    {
      name: "extra arguments",
      code: `async ({ tools: { goal_complete } }) => (goal_complete as any)({ summary: "done" }, 2)`,
      error: "tools.goal_complete expects 0-1 argument(s); received 2",
    },
  ])("checks $name on the host even when a program bypasses types", async ({ code, error }) => {
    const { ctx, executeTool } = toolContext({});
    await expect(run(code, ctx)).rejects.toThrow(error);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("offers no tools when Pi lets the call use none", async () => {
    const { ctx } = toolContext({}, []);
    await expect(
      run(`async ({ tools: { goal_complete } }) => goal_complete({ summary: "x" })`, ctx),
    ).rejects.toThrow(/tools/);
  });

  it("searches and describes the injectable tools", async () => {
    const { ctx } = toolContext({});
    const found = await value(
      `async ({ toolIndex: { search, describe } }) => ({
        found: (await search("github issues")).map((entry) => entry.name),
        summary: (await search("github issues"))[0]?.summary ?? "",
        mcpText: await describe("mcp__github__list_issues"),
        declaration: await describe("goal_complete"),
        excluded: await describe("read"),
      })`,
      ctx,
    );
    expect(found).toEqual({
      found: ["mcp__github__list_issues"],
      summary: "List issues in a GitHub repository.",
      mcpText: expect.stringContaining(
        "Supports filtering.\nReturns the server's text, often JSON: parse it with JSON.parse.",
      ),
      declaration: expect.stringMatching(
        /Mark the current goal complete\.[\s\S]*goal_complete\(args: \{\s*summary: string;?\s*\}\): Promise<string>/,
      ),
      excluded: null,
    });
  });

  it("ranks search results, honors the limit, and shortens long summaries", async () => {
    const { ctx } = toolContext({});
    const found = await value(
      `async ({ toolIndex: { search } }) => ({
        ranked: (await search("issues graph")).map((entry) => entry.name),
        limited: (await search("issues graph", 1)).map((entry) => entry.name),
        summary: (await search("principal"))[0]?.summary ?? "",
      })`,
      ctx,
    );
    expect(found).toEqual({
      ranked: ["mcp__github__list_issues", "mcp__memory__read_graph"],
      limited: ["mcp__github__list_issues"],
      summary: expect.stringMatching(/^Look up a principal by identifier.*…$/),
    });
    expect((found as { summary: string }).summary).toHaveLength(160);
  });

  it("lets saved functions inject a function deliberately named in the tools namespace", async () => {
    const { ctx, executeTool } = toolContext({});
    await tool.execute(
      "save-helper",
      {
        code: `async function helper() { return 41; }`,
        functionId: "tools.helper",
        saveOnly: true,
      },
      undefined,
      undefined,
      ctx,
    );
    expect(
      await value(
        `async function next({ tools: { helper } }) { return (await helper()) + 1; }`,
        ctx,
      ),
    ).toBe(42);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("ends the turn after a program whose nested call requested it succeeds", async () => {
    const outcome = {
      result: { content: text("Goal completed."), terminate: true },
      isError: false,
    };
    const succeeded = await run(
      `async ({ tools: { goal_complete } }) => goal_complete({ summary: "done" })`,
      toolContext({ goal_complete: outcome }).ctx,
    );
    expect(succeeded.terminate).toBe(true);
    await expect(
      run(
        `async ({ tools: { goal_complete } }) => { await goal_complete({ summary: "done" }); throw new Error("later step failed"); }`,
        toolContext({ goal_complete: outcome }).ctx,
      ),
    ).rejects.toThrow(/later step failed/);
    const plain = await run(`async () => 1`, toolContext({}).ctx);
    expect(plain.terminate).toBeUndefined();
  });

  it("attaches images a tool returns to the result", async () => {
    const image = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
    const { ctx } = toolContext({
      screenshot: { result: { content: [...text("Captured."), image] }, isError: false },
    });
    const result = await run(`async ({ tools: { screenshot } }) => screenshot()`, ctx);
    expect(result.content).toContainEqual(image);
    expect(result.content[0].text).toContain("Image: screenshot");
  });

  it("reports a returned image too large to attach instead of dropping it silently", async () => {
    const huge = { type: "image", data: "A".repeat(5 * 1024 * 1024 + 4), mimeType: "image/png" };
    const { ctx } = toolContext({
      screenshot: { result: { content: [huge] }, isError: false },
    });
    const result = await run(`async ({ tools: { screenshot } }) => screenshot()`, ctx);
    expect(result.content.some((block: { type: string }) => block.type === "image")).toBe(false);
    expect(result.content[0].text).toContain(
      "Image from screenshot not attached: the encoded image exceeds 5 MiB",
    );
  });

  it("reports returned images beyond the invocation's limit instead of dropping them silently", async () => {
    const image = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
    const { ctx } = toolContext({
      screenshot: { result: { content: Array.from({ length: 9 }, () => image) }, isError: false },
    });
    const result = await run(`async ({ tools: { screenshot } }) => screenshot()`, ctx);
    expect(result.content.filter((block: { type: string }) => block.type === "image")).toHaveLength(
      8,
    );
    expect(result.content[0].text).toContain(
      "Image from screenshot not attached: at most 8 images attach per invocation",
    );
  });
});

describe("saved functions that inject tools", () => {
  const completed = {
    goal_complete: { result: { content: text("Goal completed.") }, isError: false },
  };
  const finish = `async function finish({ tools: { goal_complete } }) { return goal_complete({ summary: "done" }); }`;
  const unavailable =
    'Function "finish" is unavailable: tools.goal_complete is not a tool Pi can call now';
  const withoutGoal = () =>
    toolContext(
      {},
      TOOLS.filter((entry) => entry.name !== "goal_complete"),
    );

  /** Pi's loadout before any other tool is callable, as when MCP servers have not connected. */
  function emptyLoadout(): ToolLoadout {
    const declared = [
      { name: "typescript", description: "Run TypeScript." },
    ] as unknown as ToolLoadout["declared"];
    return {
      declared,
      callable: [],
      registered: declared,
      getExposure: () => "model-only",
      getNamespace: () => undefined,
    };
  }

  it("saves and runs them, and keeps them when a session resumes before tools are known", async () => {
    expect(await value(finish, toolContext(completed).ctx)).toBe("Goal completed.");
    tool.prepareLoadout?.(emptyLoadout());
    await sessionStart({}, context());
    expect(await value(`async ({ finish }) => finish()`, toolContext(completed).ctx)).toBe(
      "Goal completed.",
    );
  });

  it("reports them unavailable while a tool is missing and runs them again when it returns", async () => {
    await value(finish, toolContext(completed).ctx);
    const missing = withoutGoal();
    await expect(run(`async ({ finish }) => finish()`, missing.ctx)).rejects.toThrow(unavailable);
    expect(missing.executeTool).not.toHaveBeenCalled();
    const saved = await value(
      `async ({ functions: { getSaved } }) => getSaved("finish")`,
      withoutGoal().ctx,
    );
    expect(saved).toMatchObject({ available: false });
    expect(JSON.stringify(saved)).toContain("tools.goal_complete is not a tool Pi can call now");
    expect(await value(`async ({ finish }) => finish()`, toolContext(completed).ctx)).toBe(
      "Goal completed.",
    );
  });

  it("propagates unavailability to dependent saved functions", async () => {
    const { ctx } = toolContext(completed);
    await value(finish, ctx);
    await value(
      `async function wrapUp({ finish }) { return "wrapped: " + (await finish()); }`,
      ctx,
    );
    await expect(run(`async ({ wrapUp }) => wrapUp()`, toolContext({}, []).ctx)).rejects.toThrow(
      'Function "finish" is unavailable',
    );
  });

  it("reports them available while the tool is callable", async () => {
    const { ctx } = toolContext(completed);
    await value(finish, ctx);
    expect(
      await value(`async ({ functions: { getSaved } }) => getSaved("finish")`, ctx),
    ).toMatchObject({ available: true });
  });

  it("rejects a wrongly typed save-only definition while the tool is callable", async () => {
    const { ctx } = toolContext(completed);
    await expect(
      tool.execute(
        "save-bad",
        {
          code: `async function badFinish({ tools: { goal_complete } }) { return goal_complete({ summary: 1 }); }`,
          saveOnly: true,
        },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow("Type 'number' is not assignable to type 'string'");
  });

  it("follows the loadout in /functions: available with the tool, unavailable without it", async () => {
    await value(finish, toolContext(completed).ctx);
    const shown = async (): Promise<string> => {
      const ctx = context({ mode: "tui" });
      let rendered = "";
      ctx.ui.custom = vi.fn(async (factory?: any) => {
        const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
        rendered =
          factory?.({}, theme, {}, () => undefined)
            .render(200)
            .join("\n") ?? "";
      });
      await functionsCommand.handler("show finish", ctx);
      return rendered;
    };
    const declared = [
      { name: "typescript", description: "Run TypeScript." },
    ] as unknown as ToolLoadout["declared"];
    tool.prepareLoadout?.({
      ...emptyLoadout(),
      callable: TOOLS.filter(
        (entry) => entry.name === "goal_complete",
      ) as unknown as ToolLoadout["callable"],
      declared,
    });
    expect(await shown()).not.toContain("Unavailable:");
    tool.prepareLoadout?.(emptyLoadout());
    expect(await shown()).toMatch(
      /Unavailable: .*tools\.goal_complete is not a tool Pi can call now/,
    );
  });

  it("type-checks them against the tool's real schema while it is callable", async () => {
    const { ctx } = toolContext(completed);
    await expect(
      run(
        `async function badFinish({ tools: { goal_complete } }) { return goal_complete({ summary: 1 }); }`,
        ctx,
      ),
    ).rejects.toThrow("Type 'number' is not assignable to type 'string'");
  });

  it("keeps user functions that inject tools across a reload before tools are known", async () => {
    const { ctx } = toolContext(completed);
    await value(finish, ctx);
    await value(
      `async ({ functions: { promote } }) => promote("finish", "Complete the goal", { to: "user" })`,
      ctx,
    );
    tool.prepareLoadout?.(emptyLoadout());
    await sessionStart({}, context());
    const listed = await value(
      `async ({ functions: { getSaved } }) => getSaved("finish", "user")`,
      withoutGoal().ctx,
    );
    expect(listed).toMatchObject({ scope: "user", available: false });
    expect(await value(`async ({ finish }) => finish()`, toolContext(completed).ctx)).toBe(
      "Goal completed.",
    );
  });

  it.each<{ name: string; source: string; call: string; reason: string }>([
    {
      name: "toolIndex while no tools are callable",
      source: `async function findTools({ toolIndex: { search } }) { return search("goal"); }`,
      call: `async ({ findTools }) => findTools()`,
      reason:
        'Function "findTools" is unavailable: toolIndex.search is unavailable because no other Pi tools are callable now',
    },
    {
      name: "several missing tools, naming the first",
      source: `async function both({ tools: { lookup, goal_complete } }) { await lookup({ id: "core" }); return goal_complete({ summary: "done" }); }`,
      call: `async ({ both }) => both()`,
      reason: 'Function "both" is unavailable: tools.',
    },
  ])("keeps saved functions using $name", async ({ source, call, reason }) => {
    await tool.execute(
      "save",
      { code: source, saveOnly: true },
      undefined,
      undefined,
      toolContext(completed).ctx,
    );
    tool.prepareLoadout?.(emptyLoadout());
    await sessionStart({}, context());
    await expect(run(call, toolContext({}, []).ctx)).rejects.toThrow(reason);
  });

  it("stops submitted programs that call a missing tool before running them", async () => {
    await value(finish, toolContext(completed).ctx);
    const missing = withoutGoal();
    await expect(
      run(`async ({ tools: { goal_complete } }) => goal_complete({ summary: "x" })`, missing.ctx),
    ).rejects.toThrow('Function "tools.goal_complete" is unavailable');
    expect(missing.executeTool).not.toHaveBeenCalled();
  });
});

describe("typescript's description", () => {
  function loadout(names: string[]): ToolLoadout {
    const tools = [
      { name: "typescript", description: "Run TypeScript." },
      ...TOOLS.filter((entry) => names.includes(entry.name)),
    ] as unknown as ToolLoadout["declared"];
    return {
      declared: tools,
      callable: tools,
      registered: tools,
      getExposure: (name) => (name === "typescript" ? "model-only" : "direct"),
      getNamespace: () => undefined,
    };
  }

  it("lists the injectable tools and how to find and call them", () => {
    const description =
      tool.prepareLoadout?.(loadout(["mcp__github__list_issues", "goal_complete", "read"]))
        ?.descriptions?.["typescript"] ?? "";
    expect(description.startsWith("Run TypeScript.")).toBe(true);
    expect(description).toContain(
      "2 other Pi tools are injectable from `tools`: mcp__github__list_issues, goal_complete.",
    );
    expect(description).toContain("toolIndex: { search, describe }");
    expect(description).toMatch(/instead of Pit's workspace, gh, http, or shell functions/);
  });

  it("names tools left out because their identifiers collide", () => {
    const colliding = {
      ...loadout([]),
      callable: [
        {
          name: "deploy-app",
          description: "Deploy.",
          parameters: { type: "object", properties: {} },
        },
        {
          name: "deploy_app",
          description: "Deploy too.",
          parameters: { type: "object", properties: {} },
        },
      ] as unknown as ToolLoadout["callable"],
    };
    const description = tool.prepareLoadout?.(colliding)?.descriptions?.["typescript"] ?? "";
    expect(description).toContain("1 other Pi tools are injectable from `tools`: deploy_app.");
    expect(description).toContain(
      "Not injectable because their identifiers collide with another tool's: deploy_app.",
    );
  });

  it("bounds a long tool list and counts the names it leaves out", () => {
    const many = Array.from({ length: 400 }, (_, index) => ({
      name: `mcp__server__operation_number_${index}`,
      description: "Operate.",
      parameters: { type: "object", properties: {} },
    }));
    const description =
      tool.prepareLoadout?.({
        ...loadout([]),
        callable: many as unknown as ToolLoadout["callable"],
      })?.descriptions?.["typescript"] ?? "";
    const listed =
      /injectable from `tools`: (.*), … (\d+) more \(find them with toolIndex\.search\)\./.exec(
        description,
      );
    expect(listed).not.toBeNull();
    const shown = (listed?.[1] ?? "").split(", ").length;
    expect(shown + Number(listed?.[2])).toBe(400);
    expect(shown).toBeLessThan(400);
  });

  it("keeps the original description when no other tool is callable", () => {
    expect(tool.prepareLoadout?.(loadout(["read"]))?.descriptions).toBeUndefined();
  });
});

/** Pending nested calls that settle only when Pit aborts the signal it passed to `executeTool()`. */
function pendingToolContext() {
  const calls: { name: string; signal: AbortSignal; aborted: boolean }[] = [];
  let notifyStarted!: () => void;
  const bothStarted = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  const executeTool = vi.fn(
    (name: string, _args: unknown, options: { signal: AbortSignal }) =>
      new Promise<never>((_resolve, reject) => {
        const call = { name, signal: options.signal, aborted: false };
        calls.push(call);
        if (calls.length === 2) notifyStarted();
        options.signal.addEventListener(
          "abort",
          () => {
            call.aborted = true;
            reject(new Error(`${name} aborted`));
          },
          { once: true },
        );
      }),
  );
  return { ctx: context({ tools: TOOLS, executeTool }), executeTool, calls, bothStarted };
}

const CONCURRENT_TOOL_CALLS = `async ({ tools: { goal_complete, screenshot } }) => {
  await Promise.all([goal_complete({ summary: "pending" }), screenshot()]);
  return "finished";
}`;

describe("ending a program with nested tool calls", () => {
  it.each<{
    name: string;
    end: RegExp;
    start(code: string, ctx: object, started: Promise<void>): Promise<unknown>;
  }>([
    {
      name: "cancelling the typescript call",
      end: /cancelled/i,
      start: (code, ctx, started) => {
        const controller = new AbortController();
        void started.then(() => controller.abort());
        return run(code, ctx as never, controller.signal);
      },
    },
    {
      name: "the typescript call's timeout",
      end: /timed out after 750ms/,
      start: (code, ctx) =>
        tool.execute("call-id", { code, timeoutMs: 750 }, undefined, undefined, ctx as never),
    },
  ])("$name aborts every running tools.* call", async ({ end, start }) => {
    const { ctx, executeTool, calls, bothStarted } = pendingToolContext();
    await expect(start(CONCURRENT_TOOL_CALLS, ctx, bothStarted)).rejects.toThrow(end);
    expect(calls.map((call) => call.name).sort()).toEqual(["goal_complete", "screenshot"]);
    expect(calls.every((call) => call.signal.aborted && call.aborted)).toBe(true);
    expect(executeTool).toHaveBeenCalledTimes(2);
  });
});
