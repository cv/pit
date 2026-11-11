import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";

/**
 * The host API members pit's shared host functions call: running a command and appending a
 * session entry. Pi's `ExtensionAPI` provides them unchanged; the pi-durable adapter builds them
 * from a tool call.
 */
export type PitHostApi = Pick<ExtensionAPI, "exec" | "appendEntry">;

/**
 * The context members pit's shared host functions read. Pi's `ExtensionContext` provides them
 * unchanged; the pi-durable adapter builds them from a tool call.
 */
export interface PitHostContext extends Pick<
  ExtensionContext,
  "cwd" | "hasUI" | "isProjectTrusted" | "model" | "thinkingLevel"
> {
  /** Pi's run mode, or `durable` on a pi-durable host. */
  mode: ExtensionContext["mode"] | "durable";
  ui: Pick<ExtensionUIContext, "confirm" | "input" | "select" | "notify">;
  sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionFile">;
}
