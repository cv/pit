import { AsyncLocalStorage } from "node:async_hooks";
import { stat } from "node:fs/promises";

import type { ConversationId, EntryRecord, ToolExecutionApi } from "@earendil-works/pi-durable";

import { RecoverableCallStore } from "../execution/completed-calls.js";
import { FUNCTION_ENTRY_TYPE, reconstructFunctions } from "../functions/core.js";
import { SavedFunctionService } from "../functions/service.js";
import {
  createFunctionState,
  createFunctionStateCommitQueue,
  type FunctionState,
  type FunctionStateCommit,
  reconcileFunctionState,
  stateFunctionEnvironment,
} from "../functions/state.js";
import { resolveFunctionPaths } from "../functions/storage/paths.js";
import {
  loadPitProjectConfig,
  loadProjectFunctions,
  type ProjectLoadContext,
} from "../functions/storage/project.js";
import { loadUserFunctions } from "../functions/storage/user.js";

type ToolContext = Parameters<ToolExecutionApi["commit"]>[1];

const ENTRY_PAGE_SIZE = 200;
/** Conversations whose functions stay in memory; an evicted one reloads on its next call. */
const MAX_CACHED_CONVERSATIONS = 64;

/** Appends saved-function entries to the conversation of the pit call that wrote them. */
interface EntrySink {
  append(type: string, data: unknown): void;
}

/**
 * Saved-function entry writes for one pit call: `appendEntry` is synchronous, as on Pi, so writes
 * queue in order and the call waits for them before it returns.
 */
export class DurableEntryWrites implements EntrySink {
  #pending: Promise<void> = Promise.resolve();
  #failure: unknown;
  readonly #submit: (type: string, data: unknown) => Promise<unknown>;

  constructor(submit: (type: string, data: unknown) => Promise<unknown>) {
    this.#submit = submit;
  }

  append(type: string, data: unknown): void {
    this.#pending = this.#pending.then(() => this.#write(type, data));
  }

  async #write(type: string, data: unknown): Promise<void> {
    // After a failed write, later writes would record a history the conversation never had.
    if (this.#failure !== undefined) return;
    try {
      await this.#submit(type, data);
    } catch (error) {
      this.#failure = error;
    }
  }

  /** Waits for every queued write; rejects with the first failure. */
  async settle(): Promise<void> {
    await this.#pending;
    if (this.#failure !== undefined) throw this.#failure;
  }
}

/** Where the conversation's saved functions are loaded from. */
export interface DurableFunctionSettings {
  /** The agent directory holding user functions and the user-wide `pit.json`. */
  agentDir: string;
  /** Whether project functions and the project's `.pi/pit.json` load. */
  trustProject: boolean;
}

/** One conversation's saved functions and the services that change them. */
export interface ConversationFunctions {
  functionState: FunctionState;
  commitFunctionState: FunctionStateCommit;
  savedFunctionService: SavedFunctionService;
  /** Journals of this conversation's recent failed programs. */
  recoverableCalls: RecoverableCallStore;
  /** Saved functions that could not be loaded, reported once. */
  loadErrors: string[];
  /** Why `pit.json` could not be read, reported once. */
  configErrors: string[];
  /** Informational notes for the host's log, such as project functions left unloaded. */
  notices: string[];
  /** Binds a pit call's entry writes for the duration of `operation`. */
  withWrites<T>(writes: EntrySink, operation: () => Promise<T>): Promise<T>;
  /** Appends an entry through the bound pit call. */
  appendEntry(type: string, data: unknown): void;
}

interface CachedConversation {
  functions: ConversationFunctions;
  /** User and project functions, loaded from disk. */
  persistent: Promise<void>;
  /** The conversation's own saved-function entries, replayed once per process. */
  session?: Promise<void>;
}

async function loadPersistentFunctions(
  functions: ConversationFunctions,
  cwd: string,
  settings: DurableFunctionSettings,
): Promise<void> {
  const { functionState } = functions;
  const context: ProjectLoadContext = { cwd, isProjectTrusted: () => settings.trustProject };
  const projectConfig = await loadPitProjectConfig(context, settings.agentDir);
  if (projectConfig.error) functions.configErrors.push(projectConfig.error);
  // As on Pi, only a trusted project's pit.json chooses the function directories.
  const paths = resolveFunctionPaths(cwd, projectConfig.paths, settings.agentDir);
  functionState.userDirectory = paths.user;
  functionState.projectDirectory = paths.project;
  functions.loadErrors.push(
    ...(await loadUserFunctions(
      functionState.user,
      functionState.userMetadata,
      functionState.invalidUser,
      paths.user,
    )),
    ...(await loadProjectFunctions(
      context,
      functionState.projectCandidates,
      functionState.candidateMetadata,
      {
        user: functionState.user,
        invalidDefinitions: functionState.invalidProject,
        invalidUser: functionState.invalidUser,
        directory: paths.project,
      },
    )),
  );
  functions.loadErrors.push(...reconcileFunctionState(functionState));
  if (!settings.trustProject && (await isDirectory(paths.project))) {
    functions.notices.push(
      `Project functions in ${paths.project} were not loaded: the project is not trusted (trustProject is false)`,
    );
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Every saved-function entry of the conversation, oldest first, including a fork's ancestors'. */
async function readFunctionEntries(
  api: Pick<ToolExecutionApi, "commit" | "conversationId">,
  context: ToolContext,
): Promise<EntryRecord[]> {
  return api.commit(async (tx) => {
    const entries: EntryRecord[] = [];
    let page = await tx.scanEntries(
      { conversationId: api.conversationId, order: "ascending" },
      ENTRY_PAGE_SIZE,
    );
    for (;;) {
      entries.push(...page.items.filter((entry) => entry.kind === FUNCTION_ENTRY_TYPE));
      if (page.next === undefined) return entries;
      page = await tx.scanEntries(
        { conversationId: api.conversationId },
        ENTRY_PAGE_SIZE,
        page.next,
      );
    }
  }, context);
}

function replaySessionFunctions(functions: ConversationFunctions, entries: EntryRecord[]): void {
  const { functionState } = functions;
  // Pi's custom entries carry the same data, so one replay serves both hosts.
  reconstructFunctions(
    functionState.session,
    entries.map((entry) => ({ type: "custom", customType: entry.kind, data: entry.data })),
    new Map([...functionState.user, ...functionState.projectCandidates]),
    {
      capacityBaseFunctions: new Map(),
      environment: stateFunctionEnvironment(functionState, {
        projectFunctions: functionState.projectCandidates,
      }),
    },
  );
  functions.loadErrors.push(...reconcileFunctionState(functionState));
}

function createConversationFunctions(): ConversationFunctions {
  const functionState = createFunctionState();
  const commitFunctionState = createFunctionStateCommitQueue();
  const writes = new AsyncLocalStorage<EntrySink>();
  const appendEntry = (type: string, data: unknown) => {
    const sink = writes.getStore();
    /* v8 ignore next -- entries are written only while a pit call runs. */
    if (!sink) throw new Error("Saved functions can change only during a typescript call");
    sink.append(type, data);
  };
  return {
    functionState,
    commitFunctionState,
    savedFunctionService: new SavedFunctionService({
      state: functionState,
      commit: commitFunctionState,
      appendEntry,
    }),
    recoverableCalls: new RecoverableCallStore(),
    loadErrors: [],
    configErrors: [],
    notices: [],
    withWrites: (sink, operation) => writes.run(sink, operation),
    appendEntry,
  };
}

/**
 * Saved functions per conversation. User and project functions load from disk the first time a
 * conversation needs them; session functions replay from the conversation's entries the first
 * time a pit call runs in it, so a reopened Harness or a fork sees what earlier calls saved.
 */
export class DurableFunctionStore {
  readonly #conversations = new Map<ConversationId, CachedConversation>();
  readonly #settings: DurableFunctionSettings;

  constructor(settings: DurableFunctionSettings) {
    this.#settings = settings;
  }

  #cached(conversationId: ConversationId, cwd: string): CachedConversation {
    const cached = this.#conversations.get(conversationId);
    if (cached) {
      // Most recently used last, so eviction drops the least recently used.
      this.#conversations.delete(conversationId);
      this.#conversations.set(conversationId, cached);
      return cached;
    }
    const functions = createConversationFunctions();
    const created: CachedConversation = {
      functions,
      persistent: loadPersistentFunctions(functions, cwd, this.#settings),
    };
    this.#conversations.set(conversationId, created);
    if (this.#conversations.size > MAX_CACHED_CONVERSATIONS) {
      const oldest = this.#conversations.keys().next().value;
      /* v8 ignore next -- the map holds more than its limit, so it has a first key. */
      if (oldest !== undefined) this.#conversations.delete(oldest);
    }
    return created;
  }

  /** User and project functions only, for prompt sections rendered before any pit call. */
  async persistent(conversationId: ConversationId, cwd: string): Promise<ConversationFunctions> {
    const cached = this.#cached(conversationId, cwd);
    await cached.persistent;
    return cached.functions;
  }

  /** Every layer, with the conversation's session functions replayed from its entries. */
  async forCall(
    api: Pick<ToolExecutionApi, "commit" | "conversationId">,
    context: ToolContext,
    cwd: string,
  ): Promise<ConversationFunctions> {
    const cached = this.#cached(api.conversationId, cwd);
    await cached.persistent;
    cached.session ??= readFunctionEntries(api, context).then((entries) =>
      replaySessionFunctions(cached.functions, entries),
    );
    try {
      await cached.session;
    } catch (error) {
      // A failed read is retried by the next call instead of leaving the conversation empty.
      delete cached.session;
      throw error;
    }
    return cached.functions;
  }
}
