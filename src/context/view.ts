import {
  estimateTokens,
  type ContextEditEntry,
  type ExtensionContext,
  type ProjectedSessionEntry,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";

export type SessionReader = ExtensionContext["sessionManager"];
/** The session reads a context view needs, so a view can describe an earlier leaf. */
export type ContextSource = Pick<
  SessionReader,
  "getBranch" | "buildSessionProjection" | "getLeafId"
>;
export type AgentMessage = ProjectedSessionEntry["messages"][number];
export type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;
/** A message the model reads as conversation rather than prompt and tool state. */
export type ModelMessage = Exclude<AgentMessage, { role: "system" }>;

export function isModelMessage(message: AgentMessage): message is ModelMessage {
  return message.role !== "system";
}
export type EditableContent = NonNullable<ContextEditEntry["replacement"]>["content"];

export const NOTE_TYPE = "pit.note";
export const NOTICE_TYPE = "pit.context-pressure";
export const PROVENANCE_TYPE = "pit.context-edit";
export const ELIDED_PREFIX = "[Elided by the model";
export const SUMMARY_PREFIX = "[Model summary of ";

export type ContextRole =
  | "user"
  | "assistant"
  | "toolResult"
  | "note"
  | "notice"
  | "custom"
  | "bash"
  | "summary";
export const CONTEXT_ROLES: readonly ContextRole[] = [
  "user",
  "assistant",
  "toolResult",
  "note",
  "notice",
  "custom",
  "bash",
  "summary",
];

export type ContextState = "original" | "elided" | "summarized" | "replaced";
/** Operations the model can stage. */
export type ContextOperation = "elide" | "summarize" | "note";
/** Operations a provenance record can name; `restore` appears in sessions from before #202. */
export type RecordedOperation = ContextOperation | "restore";

/** One operation recorded in a `pit.context-edit` provenance entry. */
export interface ProvenanceOperation {
  toolCallId: string;
  operation: RecordedOperation;
  targets: string[];
  /** Summarize, and restores recorded before #202: the entry carrying the summary. */
  carrier?: string;
  /** Summarize: every entry the summary replaced, including the carrier. */
  covers?: string[];
  key?: string;
  action?: "created" | "replaced" | "removed";
  reason?: string;
  tokensFreed: number;
  reprefillTokens: number;
}

export interface ProvenanceData {
  version: 1;
  operations: ProvenanceOperation[];
}

/** A model-visible contribution of one session entry. */
export interface ContextItem {
  readonly id: string;
  readonly entry: SessionEntry;
  readonly role: ContextRole;
  readonly messages: readonly ModelMessage[];
  readonly tokens: number;
  readonly state: ContextState;
  /** Tools called (assistant) or answered (tool result). */
  readonly tools: readonly string[];
  readonly toolCallIds: readonly string[];
  readonly noteKey?: string;
  readonly noticeLevel?: number;
  /** Why the model may never elide or summarize this entry. */
  readonly protectedReason?: string;
}

export interface ContextView {
  /** Model-visible entries in context order, without prompt and tool system messages. */
  readonly items: readonly ContextItem[];
  readonly byId: ReadonlyMap<string, ContextItem>;
  readonly branchIds: ReadonlySet<string>;
  /** Entries the latest compaction keeps in context, whether visible or omitted. */
  readonly contextIds: ReadonlySet<string>;
  readonly latestEdits: ReadonlyMap<string, ContextEditEntry>;
  /** Summary carrier ID to the IDs its summary covers. */
  readonly summaries: ReadonlyMap<string, readonly string[]>;
  readonly summaryOf: ReadonlyMap<string, string>;
  readonly leafId: string | null;
  readonly tokens: number;
}

const PROTECTED: Partial<Record<ContextRole, string>> = {
  user: "user message",
  bash: "user shell command",
  custom: "extension message",
  summary: "compaction or branch summary",
  note: "model note; use session.setNote",
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function firstText(content: EditableContent): string {
  if (typeof content === "string") return content;
  const block = content.find((part) => part.type === "text");
  return block?.type === "text" ? block.text : "";
}

/**
 * The raw content an entry contributed before any context edit. Callers pass only entries Pi
 * lets edits target: user, assistant, and tool-result messages, and custom messages.
 */
export function originalContent(entry: SessionEntry): EditableContent {
  if (entry.type === "custom_message") return entry.content;
  return (entry as { message: { content: EditableContent } }).message.content;
}

function stateOf(entry: SessionEntry, edit: ContextEditEntry | undefined): ContextState {
  if (!edit?.replacement) return "original";
  const { content } = edit.replacement;
  const text = firstText(content);
  if (text.startsWith(ELIDED_PREFIX)) return "elided";
  if (text.startsWith(SUMMARY_PREFIX)) return "summarized";
  return JSON.stringify(content) === JSON.stringify(originalContent(entry))
    ? "original"
    : "replaced";
}

/** Message entries Pi's API can append; anything else reads as a protected extension message. */
function messageRole(message: ModelMessage): ContextRole {
  if (message.role === "bashExecution") return "bash";
  const { role } = message;
  return role === "user" || role === "assistant" || role === "toolResult" ? role : "custom";
}

/** The role of a content-bearing entry: a message, custom message, or summary. */
export function entryRole(entry: SessionEntry): ContextRole {
  if (entry.type === "custom_message") {
    if (entry.customType === NOTE_TYPE) return "note";
    return entry.customType === NOTICE_TYPE ? "notice" : "custom";
  }
  return entry.type === "message" ? messageRole(entry.message as ModelMessage) : "summary";
}

export function toolsOf(messages: readonly AgentMessage[]): {
  tools: string[];
  toolCallIds: string[];
} {
  const tools: string[] = [];
  const toolCallIds: string[] = [];
  for (const message of messages) {
    if (message.role === "toolResult") {
      tools.push(message.toolName);
      toolCallIds.push(message.toolCallId);
    } else if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type !== "toolCall") continue;
        if (!tools.includes(block.name)) tools.push(block.name);
        toolCallIds.push(block.id);
      }
    }
  }
  return { tools, toolCallIds };
}

function customDetails(entry: SessionEntry): Record<string, unknown> | undefined {
  return entry.type === "custom_message" ? record(entry.details) : undefined;
}

function contextItem(
  projected: ProjectedSessionEntry,
  edit: ContextEditEntry | undefined,
  currentTurn: ReadonlySet<string>,
): ContextItem | undefined {
  const messages = projected.messages.filter(isModelMessage);
  if (messages.length === 0) return undefined;
  const entry = projected.sourceEntry;
  const role = entryRole(entry);
  const details = customDetails(entry);
  const protectedReason = currentTurn.has(entry.id) ? "current turn" : PROTECTED[role];
  return {
    id: entry.id,
    entry,
    role,
    messages,
    tokens: messages.reduce((sum, message) => sum + estimateTokens(message), 0),
    state: stateOf(entry, edit),
    ...toolsOf(messages),
    ...(role === "note" && typeof details?.key === "string" ? { noteKey: details.key } : {}),
    ...(role === "notice" && typeof details?.level === "number"
      ? { noticeLevel: details.level }
      : {}),
    ...(protectedReason ? { protectedReason } : {}),
  };
}

function lastIndex<T>(values: readonly T[], predicate: (value: T) => boolean): number {
  for (let index = values.length - 1; index >= 0; index--) {
    if (predicate(values[index] as T)) return index;
  }
  return -1;
}

function callsTool(entry: SessionEntry, toolCallId?: string): boolean {
  if (entry.type !== "message" || entry.message.role !== "assistant") return false;
  return (
    toolCallId === undefined ||
    entry.message.content.some((block) => block.type === "toolCall" && block.id === toolCallId)
  );
}

/**
 * The entries of the turn that is running a tool call: its assistant message and everything
 * after it. Without a matching call, the latest assistant message starts the turn.
 */
function currentTurnIds(branch: readonly SessionEntry[], toolCallId: string): Set<string> {
  let start = lastIndex(branch, (entry) => callsTool(entry, toolCallId));
  if (start < 0) start = lastIndex(branch, (entry) => callsTool(entry));
  return new Set(start < 0 ? [] : branch.slice(start).map((entry) => entry.id));
}

function recordProvenance(data: unknown, summaries: Map<string, readonly string[]>): void {
  const operations = record(data)?.operations;
  if (!Array.isArray(operations)) return;
  for (const value of operations) {
    const operation = record(value);
    if (!operation || typeof operation.carrier !== "string") continue;
    if (operation.operation === "restore") {
      summaries.delete(operation.carrier);
      continue;
    }
    const covers: unknown[] = Array.isArray(operation.covers) ? operation.covers : [];
    summaries.set(
      operation.carrier,
      covers.filter((id): id is string => typeof id === "string"),
    );
  }
}

export interface ContextViewOptions {
  /** Protects the turn running this tool call from edits. */
  toolCallId?: string;
}

export function buildContextView(
  session: ContextSource,
  options: ContextViewOptions = {},
): ContextView {
  const branch = session.getBranch();
  const projection = session.buildSessionProjection();
  const latestEdits = new Map<string, ContextEditEntry>();
  const summaries = new Map<string, readonly string[]>();
  const contextIds = new Set<string>();
  for (const { sourceEntry } of projection.entries) {
    contextIds.add(sourceEntry.id);
    if (sourceEntry.type === "context_edit") {
      latestEdits.set(sourceEntry.targetId, sourceEntry);
    } else if (sourceEntry.type === "custom" && sourceEntry.customType === PROVENANCE_TYPE) {
      recordProvenance(sourceEntry.data, summaries);
    }
  }
  const summaryOf = new Map<string, string>();
  for (const [carrier, covers] of summaries) {
    for (const id of covers) summaryOf.set(id, carrier);
  }
  const currentTurn =
    options.toolCallId === undefined
      ? new Set<string>()
      : currentTurnIds(branch, options.toolCallId);
  const items = projection.entries
    .map((projected) =>
      contextItem(projected, latestEdits.get(projected.sourceEntry.id), currentTurn),
    )
    .filter((item): item is ContextItem => item !== undefined);
  return {
    items,
    byId: new Map(items.map((item) => [item.id, item])),
    branchIds: new Set(branch.map((entry) => entry.id)),
    contextIds,
    latestEdits,
    summaries,
    summaryOf,
    leafId: session.getLeafId(),
    tokens: items.reduce((sum, item) => sum + item.tokens, 0),
  };
}
