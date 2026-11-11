import type { PitHostApi, PitHostContext } from "../host/context.js";
import type { NativeFunctionHandler } from "../host/native-dispatcher.js";
import type { ImageCollector } from "../workspace/view-image.js";

/** The dialogs a pi-durable host can answer; without them `ui.*` reports that no UI is available. */
export interface PitDurableUi {
  confirm(title: string, message: string, options?: { signal?: AbortSignal }): Promise<boolean>;
  input(
    title: string,
    placeholder?: string,
    options?: { signal?: AbortSignal },
  ): Promise<string | undefined>;
  select(
    title: string,
    options: string[],
    dialog?: { signal?: AbortSignal },
  ): Promise<string | undefined>;
  notify(message: string, level?: "info" | "warning" | "error"): void;
}

/** Where Pit reports host-level problems, such as saved functions that could not be loaded. */
export interface PitDurableLog {
  info(message: string): void;
  warning(message: string): void;
}

/** A Pit global that a pi-durable host has no counterpart for, such as `commands.list`. */
export class PitDurableUnavailableError extends Error {
  override readonly name = "PitDurableUnavailableError";
  /** The global that was called, such as `commands.list`. */
  readonly global: string;

  constructor(global: string, reason?: string) {
    super(`${global} is unavailable on pi-durable hosts${reason ? `: ${reason}` : ""}`);
    this.global = global;
  }
}

/** A handler for a namespace pi-durable has no counterpart for: every method throws. */
export function unavailableNamespace(namespace: string, reason?: string): NativeFunctionHandler {
  return (method) => {
    throw new PitDurableUnavailableError(`${namespace}.${method}`, reason);
  };
}

/* v8 ignore start -- Pit checks hasUI before every dialog, as on Pi without a UI. */
const noDialog = () => Promise.reject(new Error("UI is not available in this mode"));
const NO_UI: PitDurableUi = {
  confirm: noDialog,
  input: noDialog,
  select: noDialog,
  notify: () => undefined,
};
/* v8 ignore stop */

export interface DurableHostContextInput {
  cwd: string;
  model: PitHostContext["model"];
  thinkingLevel: NonNullable<PitHostContext["thinkingLevel"]>;
  projectTrusted: boolean;
  ui: PitDurableUi | undefined;
}

/** The Pi context members Pit's shared host functions read, answered for one pi-durable call. */
export function createDurableHostContext(input: DurableHostContextInput): PitHostContext {
  return {
    cwd: input.cwd,
    mode: "durable",
    hasUI: input.ui !== undefined,
    ui: input.ui ?? NO_UI,
    model: input.model,
    thinkingLevel: input.thinkingLevel,
    isProjectTrusted: () => input.projectTrusted,
    // A conversation lives in the host's storage, not in a session file.
    sessionManager: { getSessionFile: () => undefined },
  };
}

/**
 * The Pi API members Pit's shared host functions call, answered for one pi-durable call. Commands
 * always stream through Pit's own process runner there, so `exec` is never reached.
 */
export function createDurableHostApi(
  appendEntry: (type: string, data: unknown) => void,
): PitHostApi {
  return {
    /* v8 ignore next -- pi-durable calls always pass shell progress, which streams commands. */
    exec: () => Promise.reject(new Error("pi.exec is unavailable on pi-durable hosts")),
    appendEntry,
  };
}

/**
 * The working directory of a call: the host's override, then the call's execution environment,
 * then the agent's, then the process's.
 */
export function conversationCwd(
  override: string | undefined,
  environment: { readonly cwd: string } | undefined,
  agent: { readonly cwd?: string },
): string {
  return override ?? environment?.cwd ?? agent.cwd ?? process.cwd();
}

/**
 * pi-durable has no image reader for Pit to reuse: `workspace.viewImage` and model requests with
 * images throw, and images from nested tools are reported as omitted.
 */
export function createDurableImageCollector(): ImageCollector {
  const omitted: string[] = [];
  return {
    view: () => Promise.reject(new PitDurableUnavailableError("workspace.viewImage")),
    attached: () => [],
    attachBlock: (_image, source) => {
      omitted.push(`Image from ${source} not attached: images are unavailable on pi-durable hosts`);
    },
    omissions: () => [...omitted],
    /* v8 ignore next -- model requests, which load images, are unavailable on pi-durable hosts. */
    load: () => Promise.reject(new PitDurableUnavailableError("Image loading")),
  };
}
