import type {
  ExtensionContext,
  SessionBoundaryDraft,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";

import { ELIDED_CALLS_PREFIX } from "./view.js";

/** A notice that a reply wrote an elided-call record as text where it meant to call a tool. */
export const IMITATED_CALL_TYPE = "pit.imitated-call";

export interface ImitatedCallDetails {
  /** Whether Pit asked the model for another response to make the call. */
  continued: boolean;
}

interface Block {
  type?: unknown;
  text?: unknown;
}

/**
 * Whether an assistant message ends with an elided-call record written as its own line and makes
 * no tool call. Models that read many such records sometimes write one where they meant to call a
 * tool (#409); nothing runs, yet the transcript reads like a finished call. A record quoted inside
 * prose or a code block does not end the message on its own line, so it does not count.
 */
export function imitatesElidedCall(message: unknown): boolean {
  const { role, content } = (message ?? {}) as { role?: unknown; content?: unknown };
  if (role !== "assistant" || !Array.isArray(content)) return false;
  const blocks = content as Block[];
  if (blocks.some((block) => block.type === "toolCall")) return false;
  const texts = blocks.filter((block) => block.type === "text" && typeof block.text === "string");
  const last = String(texts.at(-1)?.text ?? "").trimEnd();
  return last.slice(last.lastIndexOf("\n") + 1).trimStart().startsWith(ELIDED_CALLS_PREFIX);
}

function noticeText(continued: boolean): string {
  const next = continued
    ? "If you meant to act, make the tool call now."
    : "Make the tool call itself if you still mean to act.";
  return `[Pit] No tool ran: your last message ended with an elided-call record written as text, not a tool call. Those records describe earlier calls that already ran; writing one runs nothing, and its action did not happen. ${next}`;
}

/** Whether the entry before an assistant message is Pit's notice about the reply before it. */
function followsNotice(event: Pick<TurnEndEvent, "messageEntryId">, ctx: ExtensionContext) {
  const { sessionManager } = ctx;
  const parentId = sessionManager.getEntry(event.messageEntryId)?.parentId;
  const parent = parentId ? sessionManager.getEntry(parentId) : undefined;
  return parent?.type === "custom_message" && parent.customType === IMITATED_CALL_TYPE;
}

/**
 * At a turn whose reply wrote an elided-call record instead of calling a tool: a notice for the
 * model and the user, and whether to continue so the model can make the call. A reply that
 * follows such a notice and repeats the mistake gets the notice without another continuation, so
 * a model that keeps writing records cannot loop.
 */
export function imitatedCallBoundary(
  event: Pick<TurnEndEvent, "message" | "messageEntryId" | "outcome">,
  ctx: ExtensionContext,
): { entry: SessionBoundaryDraft; continue: boolean } | undefined {
  if (event.outcome !== "completed" || !imitatesElidedCall(event.message)) return undefined;
  const continued = !followsNotice(event, ctx);
  const details: ImitatedCallDetails = { continued };
  return {
    entry: {
      type: "custom_message",
      customType: IMITATED_CALL_TYPE,
      content: noticeText(continued),
      display: true,
      details,
    },
    continue: continued,
  };
}
