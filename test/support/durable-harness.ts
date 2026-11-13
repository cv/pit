import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Context as ModelContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  type AgentChange,
  type Conversation,
  createRegistry,
  type EntryId,
  type EntryRecord,
  type Extension,
  Harness,
  type HarnessSettings,
  MemoryStorage,
  type Storage,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

/** One `typescript` result as the conversation recorded it for the model. */
export interface DurableToolResult {
  text: string;
  isError: boolean;
  details: any;
  diagnostics: Array<{ severity: string; message: string }>;
}

export interface DurableRun {
  results: DurableToolResult[];
  /** The prompt sections the model saw on the run's last request. */
  sections: Record<string, string>;
  /** The messages of each model request in the run, in order. */
  requests: ModelContext["messages"][];
  /** The names of the tools offered to the model on the run's first request, sorted. */
  offered: string[];
}

/** A storage that outlives each Harness, so a test can reopen the same conversations. */
function reopenable(storage: MemoryStorage): Storage {
  return new Proxy(storage, {
    get(target, property) {
      if (property === "close") return async () => undefined;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function toolResult(entry: EntryRecord): DurableToolResult {
  const message = (entry.model as any[])[0];
  return {
    text: message.content.map((block: any) => (block.type === "text" ? block.text : "")).join(""),
    isError: message.isError === true,
    details: message.details,
    diagnostics: ((entry.data as any)?.diagnostics ?? []) as DurableToolResult["diagnostics"],
  };
}

function systemSections(request: ModelContext): Record<string, string> {
  const sections: Record<string, string> = {};
  for (const message of request.messages as any[]) {
    if (message.role === "system") Object.assign(sections, message.sections ?? {});
  }
  return Object.fromEntries(Object.entries(sections).filter(([, content]) => content !== ""));
}

/** The tools a request offers: its system messages' tool changes, replayed in order. */
function offeredTools(request: ModelContext): string[] {
  const tools = new Set<string>();
  for (const message of request.messages as any[]) {
    if (message.role !== "system") continue;
    for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
  }
  return [...tools].sort();
}

/**
 * A real pi-durable Harness on MemoryStorage whose faux model calls `typescript` with the given
 * arguments, one call per turn, and then answers.
 */
export class DurableTestHost {
  readonly #storage = reopenable(new MemoryStorage());
  readonly #faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model" }] });
  readonly #models = createModels();
  readonly #extensions: Extension[];
  readonly #cwd: string;
  readonly #settings: HarnessSettings | undefined;
  #harness: Harness | undefined;

  readonly #env: boolean;
  readonly #agent: Pick<AgentChange, "modelTools">;

  constructor(input: {
    extension: Extension;
    tools?: ToolRegistration[];
    /** More extensions to install, such as pi-durable's coding tools. */
    extensions?: Extension[];
    /** Gives each conversation a Node execution environment in `cwd`. */
    env?: boolean;
    cwd: string;
    settings?: HarnessSettings;
    /** More of the root conversation's agent state, such as `modelTools`. */
    agent?: Pick<AgentChange, "modelTools">;
  }) {
    this.#env = input.env === true;
    this.#agent = input.agent ?? {};
    this.#settings = input.settings;
    this.#models.setProvider(this.#faux.provider);
    this.#extensions = [
      input.extension,
      ...(input.tools ? [{ name: "test-tools", tools: input.tools }] : []),
      ...(input.extensions ?? []),
    ];
    this.#cwd = input.cwd;
  }

  async #open(): Promise<Harness> {
    if (this.#harness) return this.#harness;
    const registry = createRegistry();
    for (const extension of this.#extensions) registry.install(extension);
    const cwd = this.#cwd;
    this.#harness = await Harness.open(
      this.#storage,
      {
        models: this.#models,
        registry,
        ...(this.#env ? { env: () => new NodeExecutionEnv({ cwd }) } : {}),
        ...(this.#settings ? { settings: this.#settings } : {}),
      },
      context,
    );
    return this.#harness;
  }

  async root(): Promise<Conversation> {
    const harness = await this.#open();
    return harness.root(context, {
      agent: { model: { provider: "faux", modelId: "faux-model" }, cwd: this.#cwd, ...this.#agent },
    });
  }

  /** Runs one user turn in which the model calls `typescript` once per program. */
  async run(
    programs: Array<Record<string, unknown>>,
    conversation?: Conversation,
    /** The user message that starts the run; a host can place it as its own entry kind. */
    input: { content: string; entry?: { kind: string; data: any } } = { content: "run" },
  ): Promise<DurableRun> {
    const target = conversation ?? (await this.root());
    let sections: Record<string, string> = {};
    const requests: ModelContext["messages"][] = [];
    let offered: string[] | undefined;
    const record = (request: ModelContext) => {
      requests.push(request.messages);
      offered ??= offeredTools(request);
    };
    this.#faux.setResponses([
      ...programs.map((args) => (request: ModelContext) => {
        record(request);
        return fauxAssistantMessage(fauxToolCall("typescript", args as Record<string, any>), {
          stopReason: "toolUse",
        });
      }),
      (request: ModelContext) => {
        record(request);
        sections = systemSections(request);
        return fauxAssistantMessage("done");
      },
    ]);
    const before = await this.#latestEntry(target);
    const submission = await target.submit({ type: "input", ...input }, context);
    const settled = await submission.wait(context);
    if (settled.status !== "done") throw new Error(`Run ended ${settled.status}`);
    // Work the run started after its answer, such as staged context edits, finishes first.
    await target.waitForIdle(context);
    const page = await target.entries(
      {
        order: "ascending",
        // Only this run's entries: a run that ended on a tool round has no answer after it.
        ...(before === undefined ? {} : { minEntryId: (before + 1) as EntryId }),
      },
      1000,
      undefined,
      context,
    );
    return {
      results: page.items.filter((entry) => entry.kind === "pi.tool-result").map(toolResult),
      sections,
      requests,
      offered: offered ?? [],
    };
  }

  /** The model context the conversation's next request would send. */
  async messages(conversation: Conversation): Promise<ModelContext["messages"]> {
    return [...(await conversation.context(context)).messages];
  }

  /** Compacts the conversation, the faux model answering the summary request with `summary`. */
  async compact(conversation: Conversation, summary: string): Promise<void> {
    this.#faux.setResponses([fauxAssistantMessage(summary)]);
    const harness = await this.#open();
    const task = await conversation.compact(undefined, context);
    await harness.waitForTask(task, context);
    await conversation.waitForIdle(context);
  }

  /** Forks the conversation at its latest entry. */
  async fork(conversation: Conversation): Promise<Conversation> {
    const latest = await this.#latestEntry(conversation);
    if (latest === undefined) throw new Error("Nothing to fork");
    return conversation.fork(latest, { ownership: { kind: "ownerless" } }, context);
  }

  /** Entries of a kind, oldest first. */
  async entries(conversation: Conversation, kind: string): Promise<EntryRecord[]> {
    const page = await conversation.entries({ order: "ascending" }, 1000, undefined, context);
    return page.items.filter((entry) => entry.kind === kind);
  }

  async #latestEntry(conversation: Conversation): Promise<EntryId | undefined> {
    const page = await conversation.entries({}, 1, undefined, context);
    return page.items[0]?.id;
  }

  /** Closes the Harness; the next call opens a new one on the same storage. */
  async close(): Promise<void> {
    await this.#harness?.close(context);
    this.#harness = undefined;
  }
}
