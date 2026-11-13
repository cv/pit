import type { PitHostApi, PitHostContext } from "../host/context.js";
import type { NativeFunctionHandler } from "../host/native-dispatcher.js";
import type { DurableQuestions, UiQuestion } from "./questions.js";

/**
 * The dialogs a pi-durable host can answer; without any `ui.*` reports that no UI is available.
 * An asynchronous host, such as a GitHub thread, implements `ask`: it posts the question and
 * returns at once, the program ends, and the answer arrives in a later run. An interactive host
 * implements the blocking dialogs instead, which Pit uses only when `ask` is absent.
 */
export interface PitDurableUi {
  /** Asynchronous hosts: post the question and return at once, with where it was posted. */
  ask?(question: UiQuestion): Promise<{ url?: string }>;
  confirm?(title: string, message: string, options?: { signal?: AbortSignal }): Promise<boolean>;
  input?(
    title: string,
    placeholder?: string,
    options?: { signal?: AbortSignal },
  ): Promise<string | undefined>;
  select?(
    title: string,
    options: string[],
    dialog?: { signal?: AbortSignal },
  ): Promise<string | undefined>;
  notify(message: string, level?: "info" | "warning" | "error"): void;
}

/** Whether the host answers any dialog, which `context.get().hasUI` reports. */
export function answersDialogs(ui: PitDurableUi | undefined): ui is PitDurableUi {
  return (
    ui?.ask !== undefined ||
    ui?.confirm !== undefined ||
    ui?.select !== undefined ||
    ui?.input !== undefined
  );
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

type Dialogs = PitHostContext["ui"];

/** A dialog the host does not implement fails as Pi's do without a UI. */
const noDialog = () => Promise.reject(new Error("UI is not available in this mode"));
/* v8 ignore start -- Pit checks hasUI before every dialog, as on Pi without a UI. */
const NO_UI: Dialogs = {
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
  /** The dialogs this call answers; absent when the host answers none. */
  ui: Dialogs | undefined;
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
 * The host's blocking dialogs with the program deadline paused while each waits for its answer,
 * so a person answering through a slow channel does not time the program out.
 */
export function pauseWhileAsking(ui: PitDurableUi, deadline: { pause(): () => void }): Dialogs {
  const paused =
    <A extends unknown[], R>(ask: ((...args: A) => Promise<R>) | undefined) =>
    async (...args: A): Promise<R> => {
      if (!ask) return noDialog();
      const resume = deadline.pause();
      try {
        return await ask(...args);
      } finally {
        resume();
      }
    };
  return {
    confirm: paused(ui.confirm?.bind(ui)),
    select: paused(ui.select?.bind(ui)),
    input: paused(ui.input?.bind(ui)),
    notify: ui.notify.bind(ui),
  };
}

/** Dialogs answered from the conversation, or posted through the host's `ask`. */
export function askingDialogs(questions: DurableQuestions, ui: PitDurableUi): Dialogs {
  return {
    confirm: (title, message) => questions.confirm(title, message),
    select: (title, options) => questions.select(title, options),
    input: (title, placeholder) => questions.input(title, placeholder),
    notify: ui.notify.bind(ui),
  };
}
