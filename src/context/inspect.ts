import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { clipText } from "../shared/bounds.js";
import { sanitizeTerminalText } from "../shared/text-sanitization.js";
import {
  entryRole,
  toolsOf,
  type AgentMessage,
  type ContextItem,
  type ContextOperation,
  type ContextRole,
  type ContextState,
  type ContextView,
  type EditableContent,
  type SessionReader,
} from "./view.js";

export const OUTLINE_LIMITS = {
  limit: { maximum: 200, fallback: 50 },
  previewChars: { maximum: 2_000, fallback: 200 },
} as const;

export const INSPECT_LIMITS = {
  limit: { maximum: 40_000, fallback: 20_000 },
  visibleChars: 4_000,
} as const;

export function contentText(content: EditableContent): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => (block.type === "text" ? block.text : "[image omitted]"))
    .join("\n");
}

function assistantText(message: Extract<AgentMessage, { role: "assistant" }>): string {
  return message.content
    .flatMap((block) => {
      if (block.type === "text") return [block.text];
      if (block.type === "toolCall") return [`→ ${block.name} ${JSON.stringify(block.arguments)}`];
      return [];
    })
    .join("\n");
}

export function messageText(message: AgentMessage): string {
  switch (message.role) {
    case "assistant":
      return assistantText(message);
    case "user":
    case "toolResult":
    case "custom":
      return contentText(message.content);
    case "bashExecution":
      return `$ ${message.command}\n${message.output}`;
    case "compactionSummary":
    case "branchSummary":
      return message.summary;
    default:
      return "";
  }
}

/** The model content an entry contributed before any edit, or undefined for state entries. */
export function entryText(entry: SessionEntry): string | undefined {
  switch (entry.type) {
    case "message":
      return messageText(entry.message);
    case "custom_message":
      return contentText(entry.content);
    case "compaction":
    case "branch_summary":
      return entry.summary;
    default:
      return undefined;
  }
}

function itemText(item: ContextItem): string {
  return item.messages.map(messageText).join("\n");
}

function preview(item: ContextItem, maxCharacters: number): string {
  const text = sanitizeTerminalText(itemText(item)).replace(/\s+/g, " ").trim();
  return maxCharacters === 0 ? "" : clipText(text, maxCharacters);
}

export interface OutlineInput {
  after?: string;
  limit: number;
  roles?: ReadonlySet<ContextRole>;
  tool?: string;
  previewChars: number;
  pending?: ReadonlyMap<string, ContextOperation>;
  usage?: { tokens: number | null; contextWindow: number } | undefined;
}

export interface OutlineEntry {
  id: string;
  role: ContextRole;
  tool?: string;
  key?: string;
  tokens: number;
  reprefillTokens: number;
  state: ContextState;
  editable: boolean;
  protectedReason?: string;
  pending?: ContextOperation;
  preview: string;
}

export interface Outline {
  leafId: string | null;
  contextTokens: number | null;
  contextWindow: number | null;
  estimatedTokens: number;
  entries: OutlineEntry[];
  nextAfter?: string;
  omitted: number;
}

function outlineEntry(
  item: ContextItem,
  reprefillTokens: number,
  input: OutlineInput,
): OutlineEntry {
  const pending = input.pending?.get(item.id);
  return {
    id: item.id,
    role: item.role,
    ...(item.tools.length > 0 ? { tool: item.tools.join(", ") } : {}),
    ...(item.noteKey === undefined ? {} : { key: item.noteKey }),
    tokens: item.tokens,
    reprefillTokens,
    state: item.state,
    editable: item.protectedReason === undefined,
    ...(item.protectedReason === undefined ? {} : { protectedReason: item.protectedReason }),
    ...(pending === undefined ? {} : { pending }),
    preview: preview(item, input.previewChars),
  };
}

function matches(item: ContextItem, input: OutlineInput): boolean {
  return (
    (input.roles === undefined || input.roles.has(item.role)) &&
    (input.tool === undefined || item.tools.includes(input.tool))
  );
}

export function outlineContext(view: ContextView, input: OutlineInput): Outline {
  const start =
    input.after === undefined ? 0 : view.items.findIndex(({ id }) => id === input.after);
  if (start < 0) {
    throw new Error(`Cursor ${input.after} is not a model-visible entry on the active branch`);
  }
  const reprefill: number[] = [];
  let suffix = 0;
  for (let index = view.items.length - 1; index >= 0; index--) {
    suffix += (view.items[index] as ContextItem).tokens;
    reprefill[index] = suffix;
  }
  const candidates = view.items
    .map((item, index) => ({ item, index }))
    .slice(input.after === undefined ? 0 : start + 1)
    .filter(({ item }) => matches(item, input));
  const page = candidates.slice(0, input.limit);
  const last = page.at(-1);
  return {
    leafId: view.leafId,
    contextTokens: input.usage?.tokens ?? null,
    contextWindow: input.usage?.contextWindow ?? null,
    estimatedTokens: view.tokens,
    entries: page.map(({ item, index }) => outlineEntry(item, reprefill[index] as number, input)),
    ...(last && candidates.length > page.length ? { nextAfter: last.item.id } : {}),
    omitted: candidates.length - page.length,
  };
}

export type InspectState = ContextState | "omitted" | "compacted";

export interface InspectedEntry {
  id: string;
  role: ContextRole;
  tool?: string;
  state: InspectState;
  original: { text: string; offset: number; totalChars: number; truncated: boolean };
  visible?: { text: string; totalChars: number; truncated: boolean };
  covers?: string[];
}

function isLowSurrogate(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Slices by UTF-16 offset without splitting a surrogate pair: a page starting inside a pair
 * starts at the pair, and a page never ends inside one or comes back empty.
 */
function sliceCharacters(
  text: string,
  offset: number,
  limit: number,
): { text: string; start: number } {
  let start = Math.min(offset, text.length);
  if (start > 0 && isLowSurrogate(text, start)) start--;
  let end = Math.min(text.length, start + limit);
  if (end < text.length && isLowSurrogate(text, end)) end = end - 1 > start ? end - 1 : end + 1;
  return { text: text.slice(start, end), start };
}

function inspectState(view: ContextView, id: string): InspectState {
  const item = view.byId.get(id);
  if (item) return item.state;
  if (!view.contextIds.has(id)) return "compacted";
  return view.summaryOf.has(id) ? "summarized" : "omitted";
}

export function inspectContextEntry(
  view: ContextView,
  session: SessionReader,
  input: { id: string; offset: number; limit: number },
): InspectedEntry {
  const entry = view.branchIds.has(input.id) ? session.getEntry(input.id) : undefined;
  if (!entry) throw new Error(`Entry ${input.id} is not on the active branch`);
  const text = entryText(entry);
  if (text === undefined) {
    throw new Error(`Entry ${input.id} (${entry.type}) contributes no model content`);
  }
  const item = view.byId.get(input.id);
  const { tools } = toolsOf(entry.type === "message" ? [entry.message] : []);
  const page = sliceCharacters(text, input.offset, input.limit);
  const state = inspectState(view, input.id);
  const visibleText = item && item.state !== "original" ? itemText(item) : undefined;
  const covers = view.summaries.get(input.id);
  return {
    id: input.id,
    role: entryRole(entry),
    ...(tools.length > 0 ? { tool: tools.join(", ") } : {}),
    state,
    original: {
      text: page.text,
      offset: page.start,
      totalChars: text.length,
      truncated: page.start + page.text.length < text.length,
    },
    ...(visibleText === undefined
      ? {}
      : {
          visible: {
            text: sliceCharacters(visibleText, 0, INSPECT_LIMITS.visibleChars).text,
            totalChars: visibleText.length,
            truncated: visibleText.length > INSPECT_LIMITS.visibleChars,
          },
        }),
    ...(covers ? { covers: [...covers] } : {}),
  };
}
