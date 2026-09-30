// Test-only offline MCP server for isolated Pi/tmux acceptance. Never configure in a normal session.
import { createInterface } from "node:readline";

const tools = [
  {
    name: "search",
    description: "Search the offline fixture docs.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "fail",
    description: "Fail with a server error, for error rendering.",
    inputSchema: {
      type: "object",
      properties: { reason: { type: "string" } },
      required: ["reason"],
    },
  },
  {
    name: "graph",
    description: "Read the fixture knowledge graph.",
    inputSchema: { type: "object", properties: {} },
    outputSchema: {
      type: "object",
      properties: {
        entities: {
          type: "array",
          items: {
            type: "object",
            properties: { name: { type: "string" }, role: { type: "string" } },
            required: ["name", "role"],
            additionalProperties: false,
          },
        },
      },
      required: ["entities"],
      additionalProperties: false,
    },
  },
  {
    name: "slow",
    description: "Answer after a delay, for progress rendering.",
    inputSchema: {
      type: "object",
      properties: { label: { type: "string" }, delayMs: { type: "number" } },
      required: ["label", "delayMs"],
    },
  },
];

// Real servers add fields their own output schemas forbid; `type` mimics the memory server.
const graph = {
  entities: [
    { type: "entity", name: "Dana Ruiz", role: "lead" },
    { type: "entity", name: "Kim Park", role: "contributor" },
  ],
};

async function callTool(params) {
  const args = params?.arguments ?? {};
  switch (params?.name) {
    case "fail":
      return {
        content: [{ type: "text", text: `fixture failure: ${args.reason}` }],
        isError: true,
      };
    case "graph":
      return { content: [{ type: "text", text: JSON.stringify(graph) }], structuredContent: graph };
    case "slow":
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(Number(args.delayMs) || 0, 10_000)),
      );
      return { content: [{ type: "text", text: `slow ${args.label} done` }] };
    default:
      return { content: [{ type: "text", text: `fixture hit for ${args.query ?? ""}` }] };
  }
}

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

function respond(message) {
  switch (message.method) {
    case "initialize":
      return {
        protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "pit-ux-fixture", version: "1.0.0" },
      };
    case "tools/list":
      return { tools };
    case "tools/call":
      return callTool(message.params);
    case "ping":
      return {};
    default:
      return undefined;
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  // Notifications have no id and need no reply.
  if (message?.id === undefined || typeof message.method !== "string") return;
  void Promise.resolve(respond(message)).then((result) =>
    send(
      result === undefined
        ? {
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: `Method not found: ${message.method}` },
          }
        : { jsonrpc: "2.0", id: message.id, result },
    ),
  );
});
