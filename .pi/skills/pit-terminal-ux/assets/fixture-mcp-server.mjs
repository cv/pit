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
];

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
      return {
        content: [
          { type: "text", text: `fixture hit for ${message.params?.arguments?.query ?? ""}` },
        ],
      };
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
  const result = respond(message);
  send(
    result === undefined
      ? {
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: `Method not found: ${message.method}` },
        }
      : { jsonrpc: "2.0", id: message.id, result },
  );
});
