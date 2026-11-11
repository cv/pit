import type { ToolExecutionApi } from "@earendil-works/pi-durable";

export type Tx = Parameters<Parameters<ToolExecutionApi["commit"]>[0]>[0];
export type EntryRecord = Awaited<ReturnType<Tx["scanEntries"]>>["items"][number];
export type EntryId = EntryRecord["id"];
export type Message = NonNullable<EntryRecord["model"]>[number];
export type AssistantMessage = Extract<Message, { role: "assistant" }>;
export type ContextEdit = NonNullable<EntryRecord["edits"]>[number];
type ToolContext = Parameters<ToolExecutionApi["commit"]>[1];

/** Pit's applied context edits: the entry that carries a rewrite and what it did. */
export const EDIT_KIND = "pit.context-edit";
/** A rewrite staged for the end of the run, applied by the entry that lists it. */
export const PENDING_EDIT_KIND = "pit.context-edit-pending";

export const ELIDED_PREFIX = "[Elided by the model";
export const ELIDED_CALLS_PREFIX = "[Pit: elided tool call";
export const SUMMARY_PREFIX = "[Model summary of ";

export type ContextRole = "user" | "assistant" | "toolResult" | "custom" | "summary";
export type ContextState = "original" | "elided" | "summarized" | "replaced";
export type ContextOperation = "elide" | "summarize";

/** What Pit records with each rewrite, so an outline can say what changed an entry. */
export interface EditProvenance {
  operation: ContextOperation;
  targets: string[];
  /** Summarize: the entry carrying the summary. */
  carrier?: string;
  /** Every entry the rewrite changed. */
  covers: string[];
  reason?: string;
  tokensFreed: number;
}

/** One model-visible entry of the active context. */
export interface ContextItem {
  readonly id: string;
  readonly entry: EntryRecord;
  readonly role: ContextRole;
  /** Messages the model sees now, after edits. */
  readonly messages: readonly Message[];
  readonly tokens: number;
  readonly state: ContextState;
  readonly tools: readonly string[];
  readonly toolCallIds: readonly string[];
  readonly protectedReason?: string;
  /** Summary carriers: the entries the summary replaced. */
  readonly covers?: readonly string[];
}

export interface ContextView {
  /** Model-visible entries in context order, without system entries. */
  readonly items: readonly ContextItem[];
  readonly byId: ReadonlyMap<string, ContextItem>;
  /** Each visible tool result, by the ID of the call it answers. */
  readonly results: ReadonlyMap<string, ContextItem>;
  /** Entries in the active range, whether or not an edit hides them. */
  readonly activeIds: ReadonlySet<string>;
  /** Targets of rewrites staged for the end of the run, by operation. */
  readonly pending: ReadonlyMap<string, ContextOperation>;
  readonly tailId: string | undefined;
  /** Estimated tokens of system entries: the prompt, sections, and tools. */
  readonly systemTokens: number;
  readonly tokens: number;
}

const SCAN_PAGE = 256;
// Assistant messages pi-durable leaves out of the model context.
const EXCLUDED_STOP_REASONS = new Set(["aborted", "error", "deferred"]);
// pi-ai's image estimate, as Pi's token heuristic uses.
const IMAGE_TOKENS = 1_200;

const PROTECTED: Partial<Record<ContextRole, string>> = {
  user: "user message",
  custom: "host message",
  summary: "compaction summary",
};

/** Pi's heuristic: about four characters per token, and a fixed cost per image. */
export function messageTokens(message: Message): number {
  let chars = 0;
  let images = 0;
  const content: unknown = message.content;
  if (typeof content === "string") chars += content.length;
  else if (Array.isArray(content)) {
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === "text") chars += String(block.text).length;
      else if (block.type === "thinking") chars += String(block.thinking).length;
      else if (block.type === "toolCall") {
        chars += String(block.name).length + JSON.stringify(block.arguments).length;
      } else if (block.type === "image") images += 1;
    }
  }
  return Math.ceil(chars / 4) + images * IMAGE_TOKENS;
}

export function messagesTokens(messages: readonly Message[]): number {
  return messages.reduce((sum, message) => sum + messageTokens(message), 0);
}

function contributes(message: Message): boolean {
  return !(message.role === "assistant" && EXCLUDED_STOP_REASONS.has(message.stopReason));
}

function roleOf(entry: EntryRecord, message: Message): ContextRole {
  if (entry.kind === "pi.compaction") return "summary";
  if (message.role === "assistant") return "assistant";
  if (message.role === "toolResult") return "toolResult";
  return entry.kind === "pi.user" ? "user" : "custom";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function provenanceOf(entry: EntryRecord): EditProvenance[] {
  const data = entry.data;
  if (!isRecord(data) || !Array.isArray(data.operations)) return [];
  return data.operations.filter(isRecord) as unknown as EditProvenance[];
}

/** The entries from the newest head marker through the tail, read in one commit. */
async function readActiveRange(
  api: Pick<ToolExecutionApi, "commit" | "conversationId">,
  context: ToolContext,
): Promise<{ head: EntryRecord | undefined; entries: EntryRecord[] }> {
  return api.commit(async (tx) => {
    const head = await tx.latestHeadMarker(api.conversationId);
    const entries: EntryRecord[] = [];
    const query = {
      conversationId: api.conversationId,
      order: "ascending",
      ...(head?.head === undefined ? {} : { minEntryId: head.head }),
    } as const;
    let page = await tx.scanEntries(query, SCAN_PAGE);
    entries.push(...page.items);
    while (page.next !== undefined) {
      page = await tx.scanEntries(query, SCAN_PAGE, page.next);
      entries.push(...page.items);
    }
    return { head, entries };
  }, context);
}

/** The newest edit of each target, what Pit recorded about it, and rewrites still staged. */
function collectEdits(entries: readonly EntryRecord[]) {
  const edits = new Map<EntryId, { edit: ContextEdit; by: EntryRecord }>();
  const provenance = new Map<string, EditProvenance>();
  const pendingEntries: EntryRecord[] = [];
  const applied = new Set<string>();
  for (const entry of entries) {
    for (const edit of entry.edits ?? []) edits.set(edit.target, { edit, by: entry });
    for (const operation of provenanceOf(entry)) {
      for (const target of operation.covers) provenance.set(target, operation);
    }
    if (entry.kind === PENDING_EDIT_KIND) pendingEntries.push(entry);
    if (entry.kind === EDIT_KIND && isRecord(entry.data) && Array.isArray(entry.data.pending)) {
      for (const id of entry.data.pending) applied.add(String(id));
    }
  }
  const pending = new Map<string, ContextOperation>();
  for (const entry of pendingEntries) {
    if (applied.has(String(entry.id))) continue;
    for (const operation of provenanceOf(entry)) {
      for (const target of operation.covers) {
        pending.set(target, operation.operation);
      }
    }
  }
  return { edits, provenance, pending };
}

/**
 * The active context as pi-durable assembles it: the newest head marker, then the non-head entries
 * from its head through the tail, each contributing its messages after the newest edit that targets
 * it. `callId` is the running tool call; its turn is protected.
 */
export async function readContextView(
  api: Pick<ToolExecutionApi, "commit" | "conversationId">,
  context: ToolContext,
  callId: string,
): Promise<ContextView> {
  const { head, entries } = await readActiveRange(api, context);
  const { edits, provenance, pending } = collectEdits(entries);
  const active = [
    ...(head ? [head] : []),
    ...entries.filter((entry) => entry.head === undefined && entry.id !== head?.id),
  ];
  const items: ContextItem[] = [];
  let systemTokens = 0;
  let currentTurn = false;
  for (const entry of active) {
    const original = (entry.model ?? []).filter(contributes);
    const edited = edits.get(entry.id);
    const messages =
      edited === undefined ? original : edited.edit.action === "omit" ? [] : edited.edit.messages;
    const first = original[0];
    if (first === undefined) continue;
    if (first.role === "system") {
      systemTokens += messagesTokens(messages);
      continue;
    }
    if (messages.length === 0) continue;
    const id = String(entry.id);
    const role = roleOf(entry, first);
    const calls =
      first.role === "assistant"
        ? first.content.flatMap((block) => (block.type === "toolCall" ? [block] : []))
        : [];
    if (calls.some((call) => call.id === callId)) currentTurn = true;
    const operation = edited ? provenance.get(id) : undefined;
    const state: ContextState = !edited
      ? "original"
      : operation?.operation === "elide"
        ? "elided"
        : operation?.operation === "summarize"
          ? "summarized"
          : "replaced";
    const protectedReason = currentTurn ? "current turn" : PROTECTED[role];
    items.push({
      id,
      entry,
      role,
      messages,
      tokens: messagesTokens(messages),
      state,
      tools: first.role === "toolResult" ? [first.toolName] : calls.map((call) => call.name),
      toolCallIds: first.role === "toolResult" ? [first.toolCallId] : calls.map((call) => call.id),
      ...(protectedReason ? { protectedReason } : {}),
      ...(operation?.carrier === id ? { covers: operation.covers } : {}),
    });
  }
  const byId = new Map(items.map((item) => [item.id, item]));
  const results = new Map(
    items.flatMap((item) =>
      item.role === "toolResult" ? item.toolCallIds.map((call) => [call, item] as const) : [],
    ),
  );
  return {
    items,
    byId,
    results,
    activeIds: new Set(active.map((entry) => String(entry.id))),
    pending,
    tailId: entries.length === 0 ? undefined : String(entries.at(-1)?.id),
    systemTokens,
    tokens: systemTokens + items.reduce((sum, item) => sum + item.tokens, 0),
  };
}
