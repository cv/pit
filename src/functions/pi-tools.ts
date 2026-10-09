/**
 * The Pi tools a `typescript` call may run through `ctx.executeTool()`, bound as typed `tools.*`
 * functions, plus `toolIndex` search. The catalog is derived from the calling tool's context for
 * every call, so it lists only tools Pi lets that call use. Declarations come from Pi's codemode
 * package, so identifiers and types match what codemode shows for the same tools.
 */
import {
  mcpStructuredContentSchema,
  renderToolSignature,
  toCodemodeIdentifier,
} from "@earendil-works/pi-codemode/declarations";

import { isRecord } from "../shared/records.js";
import { defineNativeFunction, type NativeFunctionDefinition } from "./global-definition.js";

const PI_TOOLS_NAMESPACE = "tools";
export const TOOL_INDEX_NAMESPACE = "toolIndex";

/**
 * Tools Pit does not bind: itself, other orchestrators, and Pi's file and shell built-ins, which
 * Pit's `workspace` and `shell` functions supersede.
 */
const EXCLUDED_TOOLS = new Set([
  "typescript",
  "codemode",
  "tool_search",
  "read",
  "bash",
  "powershell",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
]);
const TEXT_OUTPUT = { type: "string" };
const MAX_SUMMARY_CHARS = 160;
const MAX_LISTED_NAME_CHARS = 6000;
const MAX_CACHED_CATALOGS = 8;
const MCP_TEXT_NOTE = "Returns the server's text, often JSON: parse it with JSON.parse.";

export type JsonSchema = Record<string, unknown>;

/** The fields of Pi's tool definitions the catalog uses. */
interface PiToolInfo {
  readonly name: string;
  readonly description?: string;
  readonly parameters?: unknown;
  readonly outputSchema?: unknown;
}

export interface PiToolBinding {
  /** Identifier under `tools`. */
  readonly method: string;
  readonly toolName: string;
  readonly summary: string;
  readonly description: string;
  readonly declaration: string;
  /** MCP tools wrap the server's result in a `CallToolResult`, which the call unwraps. */
  readonly mcp: boolean;
  /** Schema of the structured value the call returns. Without one, the call returns text. */
  readonly outputSchema?: JsonSchema;
}

export interface PiToolCatalog {
  readonly bindings: ReadonlyMap<string, PiToolBinding>;
  readonly definitions: readonly NativeFunctionDefinition[];
  /** Type-checking contract that adds `tools` and `toolIndex` to `PitGlobalFunctions`. */
  readonly declarations: string;
  /** Documented member declarations under `tools`, for extending the contract. */
  readonly members: readonly string[];
  /** Tools left unbound because an earlier tool maps to the same identifier. */
  readonly collisions: readonly string[];
}

interface PiToolSearchResult {
  name: string;
  summary: string;
}

const TOOL_INDEX_MEMBERS = [
  [
    "search",
    "search(query: string, limit?: number): Promise<Array<{ name: string; summary: string }>>;",
    "Search the injectable tools by name and description",
    1,
    2,
  ],
  [
    "describe",
    "describe(name: string): Promise<string | null>;",
    "Show a tool's description and TypeScript declaration",
    1,
    1,
  ],
] as const;

const catalogCache = new Map<string, PiToolCatalog>();

// Tool arguments and results cross a JSON boundary, so `unknown` there is always JSON, and Pit
// requires JSON-typed program results.
function jsonTyped(declaration: string): string {
  return declaration.replace(/\bunknown\b/g, "PitJsonValue");
}

function firstSentence(text: string): string {
  const collapsed = text.trim().replace(/\s+/g, " ");
  const end = collapsed.search(/[.!?](\s|$)/);
  const sentence = end < 0 ? collapsed : collapsed.slice(0, end + 1);
  return sentence.length > MAX_SUMMARY_CHARS
    ? `${sentence.slice(0, MAX_SUMMARY_CHARS - 1)}…`
    : sentence;
}

function docComment(text: string, indent: string): string {
  return text ? `${indent}/** ${text.replaceAll("*/", "*\\/")} */\n` : "";
}

function isParameterless(schema: unknown): boolean {
  return (
    !isRecord(schema) || !isRecord(schema.properties) || !Object.keys(schema.properties).length
  );
}

function binding(tool: PiToolInfo, method: string): PiToolBinding {
  // MCP tools declare a CallToolResult wrapper; the call returns what it wraps.
  const wrapped = mcpStructuredContentSchema(tool.outputSchema as never);
  const mcp = wrapped !== undefined;
  const output = mcp ? wrapped : tool.outputSchema;
  const structured = isRecord(output) ? (output as JsonSchema) : undefined;
  let declaration = jsonTyped(
    renderToolSignature({
      name: tool.name,
      inputSchema: (tool.parameters ?? { type: "object" }) as never,
      outputSchema: (structured ?? TEXT_OUTPUT) as never,
    }),
  );
  // A schema without properties renders as an index signature, but the tool takes no arguments.
  if (isParameterless(tool.parameters)) {
    declaration = declaration.replace(/^([\w$]+)\(args: [^)]*\)/, "$1(args?: {})");
  }
  const description = (tool.description ?? "").trim();
  const summary = firstSentence(description);
  return {
    method,
    toolName: tool.name,
    summary,
    description,
    declaration,
    mcp,
    ...(structured ? { outputSchema: structured } : {}),
  };
}

function toolIndexDefinitions(): NativeFunctionDefinition[] {
  return TOOL_INDEX_MEMBERS.map(([method, declaration, summary, minimum, maximum]) =>
    defineNativeFunction(TOOL_INDEX_NAMESPACE, method, {
      declaration,
      summary,
      documentation: `${TOOL_INDEX_NAMESPACE}.${method} inspects the tools injectable from ${PI_TOOLS_NAMESPACE}`,
      minimumArguments: minimum,
      maximumArguments: maximum,
    }),
  );
}

function buildCatalog(tools: readonly PiToolInfo[]): PiToolCatalog {
  const bindings = new Map<string, PiToolBinding>();
  const collisions: string[] = [];
  for (const tool of tools) {
    const method = toCodemodeIdentifier(tool.name);
    if (bindings.has(method)) {
      collisions.push(tool.name);
      continue;
    }
    bindings.set(method, binding(tool, method));
  }
  if (bindings.size === 0) {
    return { bindings, definitions: [], declarations: "", members: [], collisions };
  }
  const definitions = [
    ...[...bindings.values()].map((entry) =>
      defineNativeFunction(PI_TOOLS_NAMESPACE, entry.method, {
        declaration: entry.declaration,
        summary: entry.summary || entry.toolName,
        documentation: `${PI_TOOLS_NAMESPACE}.${entry.method} runs the Pi tool ${entry.toolName}`,
        minimumArguments: 0,
        maximumArguments: 1,
      }),
    ),
    ...toolIndexDefinitions(),
  ];
  const members = [...bindings.values()].map(
    (entry) => `${docComment(entry.summary, "    ")}    ${entry.declaration}`,
  );
  return {
    bindings,
    definitions,
    declarations: renderDeclarations(members, true),
    members,
    collisions,
  };
}

function renderDeclarations(members: readonly string[], toolIndex: boolean): string {
  const blocks = [
    ...(members.length ? [`  ${PI_TOOLS_NAMESPACE}: {\n${members.join("\n")}\n  };`] : []),
    ...(toolIndex
      ? [
          `  ${TOOL_INDEX_NAMESPACE}: {\n${TOOL_INDEX_MEMBERS.map(([, declaration]) => `    ${declaration}`).join("\n")}\n  };`,
        ]
      : []),
  ];
  return blocks.length ? `\ninterface PitGlobalFunctions {\n${blocks.join("\n")}\n}\n` : "";
}

const EMPTY_CATALOG: PiToolCatalog = {
  bindings: new Map(),
  definitions: [],
  declarations: "",
  members: [],
  collisions: [],
};

/**
 * Extends a catalog with placeholders for tools that saved functions inject but Pi does not offer
 * now, for example while an MCP server is disconnected. A placeholder type-checks loosely and
 * resolves as unavailable, so the saved function is kept and works again when the tool returns.
 */
export function withMissingPiTools(
  catalog: PiToolCatalog | undefined,
  dependencyIds: Iterable<string>,
): PiToolCatalog | undefined {
  const base = catalog ?? EMPTY_CATALOG;
  const tools = new Set<string>();
  let toolIndex = false;
  for (const id of dependencyIds) {
    const [namespace, method, ...rest] = id.split(".");
    /* v8 ignore next -- dependency ids under a namespace name one member; others fail validation. */
    if (!method || rest.length > 0) continue;
    if (namespace === PI_TOOLS_NAMESPACE && !base.bindings.has(method)) tools.add(method);
    if (namespace === TOOL_INDEX_NAMESPACE && base.bindings.size === 0) toolIndex = true;
  }
  if (tools.size === 0 && !toolIndex) return catalog;
  const missing = [...tools].sort((left, right) => left.localeCompare(right));
  const placeholders = missing.map((method) => {
    const reason = `${PI_TOOLS_NAMESPACE}.${method} is not a tool Pi can call now; the extension or MCP server that provides it may not be loaded`;
    return {
      member: `${docComment("Not callable now.", "    ")}    ${method}(args?: { [key: string]: PitJsonValue }): Promise<PitJsonValue>;`,
      definition: {
        ...defineNativeFunction(PI_TOOLS_NAMESPACE, method, {
          declaration: `${method}(args?: { [key: string]: PitJsonValue }): Promise<PitJsonValue>;`,
          summary: "Not callable now",
          documentation: reason,
          minimumArguments: 0,
          maximumArguments: 1,
        }),
        unavailable: reason,
      },
    };
  });
  const indexPlaceholders = toolIndex
    ? toolIndexDefinitions().map((definition) =>
        Object.assign({}, definition, {
          unavailable: `${definition.id} is unavailable because no other Pi tools are callable now`,
        }),
      )
    : [];
  const members = [...base.members, ...placeholders.map(({ member }) => member)];
  return {
    ...base,
    definitions: [
      ...base.definitions,
      ...placeholders.map(({ definition }) => definition),
      ...indexPlaceholders,
    ],
    declarations: renderDeclarations(members, base.bindings.size > 0 || toolIndex),
    members,
  };
}

/** The catalog for the tools a call may use. Returns the same object for the same tools. */
export function createPiToolCatalog(tools: readonly PiToolInfo[] | undefined): PiToolCatalog {
  const usable = (tools ?? []).filter((tool) => !EXCLUDED_TOOLS.has(tool.name));
  const fingerprint = JSON.stringify(
    usable.map((tool) => [tool.name, tool.description, tool.parameters, tool.outputSchema]),
  );
  const cached = catalogCache.get(fingerprint);
  if (cached) {
    catalogCache.delete(fingerprint);
    catalogCache.set(fingerprint, cached);
    return cached;
  }
  const catalog = buildCatalog(usable);
  catalogCache.set(fingerprint, catalog);
  /* v8 ignore next 3 -- defensive cache capacity bound. */
  if (catalogCache.size > MAX_CACHED_CATALOGS) {
    catalogCache.delete(catalogCache.keys().next().value as string);
  }
  return catalog;
}

export function isPiToolNamespace(namespace: string): boolean {
  return namespace === PI_TOOLS_NAMESPACE || namespace === TOOL_INDEX_NAMESPACE;
}

/** Guidance appended to `typescript`'s description while other tools are callable. */
export function piToolPrompt(catalog: PiToolCatalog): string {
  if (catalog.bindings.size === 0) return "";
  const names: string[] = [];
  let length = 0;
  for (const method of catalog.bindings.keys()) {
    if (length + method.length + 2 > MAX_LISTED_NAME_CHARS) break;
    names.push(method);
    length += method.length + 2;
  }
  const omitted = catalog.bindings.size - names.length;
  const listed = `${names.join(", ")}${omitted > 0 ? `, … ${omitted} more (find them with toolIndex.search)` : ""}`;
  const collisions = catalog.collisions.length
    ? [
        `Not injectable because their identifiers collide with another tool's: ${catalog.collisions.join(", ")}.`,
      ]
    : [];
  return [
    "",
    "",
    `TOOLS: ${catalog.bindings.size} other Pi tools are injectable from \`${PI_TOOLS_NAMESPACE}\`: ${listed}.`,
    ...collisions,
    `Before calling one, inject \`${TOOL_INDEX_NAMESPACE}: { search, describe }\`: search(query) ranks tools by name and description; describe(name) returns the declaration to call it with. Then call it, for example \`async ({ ${PI_TOOLS_NAMESPACE}: { NAME } }) => NAME({ ... })\`.`,
    "Calls run through Pi like direct tool calls. A call returns the tool's declared structured value, otherwise its text (MCP text is often JSON: parse it with JSON.parse). A failed call throws.",
    "When one of these tools covers a service, use it instead of Pit's workspace, gh, http, or shell functions: those act on this machine and the user's own accounts, not on the configured servers.",
  ].join("\n");
}

export function searchPiTools(
  catalog: PiToolCatalog,
  query: string,
  limit = 8,
): PiToolSearchResult[] {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const bounded = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 20) : 8;
  return [...catalog.bindings.values()]
    .map((entry) => {
      const name = entry.method.toLowerCase();
      const description = entry.description.toLowerCase();
      const score = terms.reduce(
        (total, term) =>
          total + (name.includes(term) ? 3 : 0) + (description.includes(term) ? 1 : 0),
        0,
      );
      return { entry, score };
    })
    .filter(({ score }) => score > 0)
    .sort(
      (left, right) =>
        right.score - left.score || left.entry.method.localeCompare(right.entry.method),
    )
    .slice(0, bounded)
    .map(({ entry }) => ({ name: entry.method, summary: entry.summary }));
}

export function describePiTool(catalog: PiToolCatalog, name: string): string | null {
  const entry = catalog.bindings.get(name) ?? catalog.bindings.get(toCodemodeIdentifier(name));
  if (!entry) return null;
  const note = entry.mcp && !entry.outputSchema ? `\n${MCP_TEXT_NOTE}` : "";
  return `${entry.description}${note}\n\n${entry.declaration}`.trim();
}
