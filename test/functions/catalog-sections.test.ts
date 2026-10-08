import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { planCatalogSections, recordedCatalogs } from "../../src/functions/catalog-sections.js";
import { SessionBuilder } from "../support/context-session.js";
import {
  beforeAgentStart,
  cleanupHarness,
  context,
  sessionTree,
  setupHarness,
} from "../support/extension-fixture.js";

beforeEach(setupHarness);
afterEach(cleanupHarness);

const OLD_CATALOG = [
  "## Project functions",
  "Parameter docs: functions.get(name).",
  "- old.fn(input: { id: string }) — Does the old thing.",
].join("\n");

const MODEL = {
  provider: "proxy",
  id: "claude",
  api: "anthropic-messages",
  promptCache: { short: 270 },
};

/**
 * A session whose system prompt recorded an older project catalog, and whose last request ran
 * `idleSeconds` ago. The fixture loads no project functions, so the current catalog is empty.
 */
function recordedSession(idleSeconds: number) {
  const session = new SessionBuilder();
  session.manager.appendMessage({
    role: "system",
    content: "",
    sections: { pit_project_functions: OLD_CATALOG },
    timestamp: Date.now() - 600_000,
  } as any);
  session.user("Keep going");
  session.manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Done." }],
    api: MODEL.api,
    provider: MODEL.provider,
    model: MODEL.id,
    usage: {
      input: 10,
      output: 5,
      cacheRead: 9_000,
      cacheWrite: 0,
      totalTokens: 9_015,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now() - idleSeconds * 1000,
  } as any);
  return session;
}

/** The second prompt of a run: the first one after registration always sends the catalogs. */
function secondPrompt(session: SessionBuilder, model: Record<string, unknown> = MODEL) {
  const ctx = context({ sessionManager: session.manager, model });
  beforeAgentStart({ systemPrompt: "base" }, ctx);
  return beforeAgentStart({ systemPrompt: "base" }, ctx);
}

describe("saved-function catalogs in the system prompt", () => {
  it("keeps the recorded catalog while the cache is warm, and announces the change", () => {
    const prompt = secondPrompt(recordedSession(30));

    expect(prompt.sections).toEqual({ pit_project_functions: OLD_CATALOG });
    expect(prompt.returned).toEqual({
      message: {
        customType: "pit.catalog-update",
        content: expect.stringContaining("Project functions:\n- old.fn (removed)"),
        display: true,
        details: { sections: { pit_project_functions: "" }, added: 0, removed: 1 },
      },
    });
  });

  it("keeps a catalog the prompt already removed unset while holding", () => {
    const session = recordedSession(30);
    session.manager.appendMessage({
      role: "system",
      content: "",
      sections: { pit_project_functions: null, rules: "Be brief." },
      timestamp: Date.now() - 20_000,
    } as any);

    // The catalog is empty now too, so there is nothing to restore or announce.
    expect(secondPrompt(session)).toMatchObject({ sections: {}, returned: undefined });
  });

  it("announces each change once", () => {
    const session = recordedSession(30);
    const first = secondPrompt(session).returned as { message: any };
    const { customType, content, display, details } = first.message;
    session.manager.appendCustomMessageEntry(customType, content, display, details);

    const prompt = beforeAgentStart(
      { systemPrompt: "base" },
      context({ sessionManager: session.manager, model: MODEL }),
    );

    expect(prompt.sections).toEqual({ pit_project_functions: OLD_CATALOG });
    expect(prompt.returned).toBeUndefined();
  });

  it.each<{ name: string; idleSeconds: number; model: Record<string, unknown> }>([
    { name: "the cache has expired", idleSeconds: 600, model: MODEL },
    {
      name: "the model keeps mid-conversation system messages",
      idleSeconds: 30,
      model: { ...MODEL, compat: { supportsMidConvoSystemMessages: true } },
    },
  ])("sends the current catalog when $name", ({ idleSeconds, model }) => {
    const prompt = secondPrompt(recordedSession(idleSeconds), model);

    // The empty current catalog stays unset, so Pi records the section's removal.
    expect(prompt.sections).toEqual({});
    expect(prompt.returned).toBeUndefined();
  });

  it("sends the current catalog on the first prompt after a branch change", async () => {
    const session = recordedSession(30);
    const ctx = context({ sessionManager: session.manager, model: MODEL });
    beforeAgentStart({ systemPrompt: "base" }, ctx);

    await sessionTree({}, ctx);

    expect(beforeAgentStart({ systemPrompt: "base" }, ctx)).toMatchObject({
      sections: {},
      returned: undefined,
    });
  });
});

describe("catalog announcements", () => {
  it("lists added and changed functions in full and removed ones by name", () => {
    const current = [
      "## Project functions",
      "Parameter docs: functions.get(name).",
      "- old.fn(input: { id: string; force?: boolean }) — Does the old thing.",
      "- new.fn() — Does a new thing.",
    ].join("\n");
    const recorded = recordedCatalogs([], null);
    recorded.system.set("pit_user_functions", "## User functions\n- gone.fn() — Went away.");
    recorded.seen.set("pit_user_functions", "## User functions\n- gone.fn() — Went away.");
    recorded.seen.set("pit_project_functions", OLD_CATALOG);

    const plan = planCatalogSections(
      { pit_user_functions: "", pit_project_functions: current },
      recorded,
      true,
    );

    expect(plan.sections).toEqual({
      pit_user_functions: "## User functions\n- gone.fn() — Went away.",
      pit_project_functions: undefined,
    });
    expect(plan.message?.content.split("\n").slice(1)).toEqual([
      "User functions:",
      "- gone.fn (removed)",
      "Project functions:",
      "+ old.fn(input: { id: string; force?: boolean }) — Does the old thing.",
      "+ new.fn() — Does a new thing.",
    ]);
    expect(plan.message?.details).toMatchObject({ added: 2, removed: 1 });
  });
});
