import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Context as ModelContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  type Conversation,
  createRegistry,
  type EntryId,
  type EntryRecord,
  type Extension,
  Harness,
  MemoryStorage,
  type Storage,
  type ToolRegistration,
} from "@earendil-works/pi-durable";

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
  #harness: Harness | undefined;

  constructor(input: { extension: Extension; tools?: ToolRegistration[]; cwd: string }) {
    this.#models.setProvider(this.#faux.provider);
    this.#extensions = [
      input.extension,
      ...(input.tools ? [{ name: "test-tools", tools: input.tools }] : []),
    ];
    this.#cwd = input.cwd;
  }

  async #open(): Promise<Harness> {
    if (this.#harness) return this.#harness;
    const registry = createRegistry();
    for (const extension of this.#extensions) registry.install(extension);
    this.#harness = await Harness.open(this.#storage, { models: this.#models, registry }, context);
    return this.#harness;
  }

  async root(): Promise<Conversation> {
    const harness = await this.#open();
    return harness.root(context, {
      agent: { model: { provider: "faux", modelId: "faux-model" }, cwd: this.#cwd },
    });
  }

  /** Runs one user turn in which the model calls `typescript` once per program. */
  async run(
    programs: Array<Record<string, unknown>>,
    conversation?: Conversation,
  ): Promise<DurableRun> {
    const target = conversation ?? (await this.root());
    let sections: Record<string, string> = {};
    this.#faux.setResponses([
      ...programs.map((args) =>
        fauxAssistantMessage(fauxToolCall("typescript", args as Record<string, any>), {
          stopReason: "toolUse",
        }),
      ),
      (request: ModelContext) => {
        sections = systemSections(request);
        return fauxAssistantMessage("done");
      },
    ]);
    const before = await this.#latestEntry(target);
    const submission = await target.submit({ type: "input", content: "run" }, context);
    const settled = await submission.wait(context);
    if (settled.status !== "done") throw new Error(`Run ended ${settled.status}`);
    const page = await target.entries(
      { order: "ascending", ...(before === undefined ? {} : { minEntryId: before }) },
      1000,
      undefined,
      context,
    );
    return {
      results: page.items.filter((entry) => entry.kind === "pi.tool-result").map(toolResult),
      sections,
    };
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
