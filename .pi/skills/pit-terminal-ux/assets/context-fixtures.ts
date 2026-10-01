/** Test-only context-editing fixtures for the offline UX provider. Never load in a normal session. */
import type { getCurrentTools, ToolCall } from "@earendil-works/pi-ai";

/** Run `context-setup` first; each edit applies when the turn that staged it ends. */
export const contextFixtures: Record<string, ToolCall["arguments"]> = {
  "context-setup": {
    label: "CONTEXT SETUP: long build log",
    code: 'async ({ shell: { execFile } }, input: { script: string }) => execFile("node", ["--input-type=module", "--eval", input.script], { timeoutMs: 5000 })',
    params: {
      script:
        "for (let i = 1; i <= 200; i++) console.log('build log line ' + i + ': compiling module ' + i);",
    },
    timeoutMs: 10000,
  },
  "context-outline": {
    label: "CONTEXT: outline",
    code: "async ({ session: { outline } }) => outline({ limit: 20, previewChars: 80 })",
  },
  "context-elide": {
    label: "CONTEXT: elide the largest stale result",
    code: `async ({ session: { outline, elide } }) => {
      const { entries } = await outline({ roles: ["toolResult"], limit: 200 });
      const candidates = entries.filter((entry) => entry.editable && entry.state === "original");
      candidates.sort((left, right) => right.tokens - left.tokens);
      const target = candidates[0];
      if (!target) throw new Error("No tool result to elide; run context-setup first");
      return elide([target.id], { reason: "stale fixture build log" });
    }`,
  },
  "context-note": {
    label: "CONTEXT: keep a progress note",
    code: 'async ({ session: { setNote } }) => setNote("progress", "Baseline build log captured.\\nNext: elide it and keep this note.")',
  },
  "context-summarize": {
    label: "CONTEXT: summarize the setup turn",
    code: `async ({ session: { outline, summarize } }) => {
      const { entries } = await outline({ limit: 200 });
      const start = entries.findIndex((entry) => entry.role === "assistant" && entry.editable);
      const first = entries[start];
      const result = entries[start + 1];
      if (!first || !result) throw new Error("No completed turn to summarize; run context-setup first");
      return summarize({ from: first.id, to: result.id, summary: "Setup printed a 200-line build log; nothing failed." });
    }`,
  },
};

/** What a request sends after Pit's context edits: message roles, stubs, summaries, and notes. */
export function describeContext(messages: Parameters<typeof getCurrentTools>[0]): string {
  const visible = messages.filter((message) => message.role !== "system");
  const texts = visible.flatMap((message) => {
    const content =
      typeof message.content === "string"
        ? [{ type: "text" as const, text: message.content }]
        : message.content;
    return content.flatMap((block) =>
      block.type === "text" ? [{ role: message.role, text: block.text }] : [],
    );
  });
  const roles = new Map<string, number>();
  for (const message of visible) roles.set(message.role, (roles.get(message.role) ?? 0) + 1);
  const report = (label: string, prefix: string) => {
    const found = texts.filter((item) => item.text.startsWith(prefix));
    const first = found[0];
    const sample = first
      ? ` — ${first.role}: ${first.text.replace(/\s+/g, " ").slice(0, 150)}`
      : "";
    return `${label}: ${found.length}${sample}`;
  };
  const counts = [...roles].map(([role, count]) => `${role} ${count}`).join(", ");
  return [
    `Model-visible messages: ${visible.length} (${counts})`,
    report("Elision stubs", "[Elided by the model"),
    report("Summaries", "[Model summary of"),
    report("Notes", "<model-note"),
    report("Pressure notices", "[Pit] Context"),
    "Fixture completed.",
  ].join("\n");
}

/** Messages Pit appends at turn end for the model; the fixture treats them as part of the turn. */
export function isPitContextMessage(
  message: Parameters<typeof getCurrentTools>[0][number],
): boolean {
  if (message.role !== "user") return false;
  const text =
    typeof message.content === "string"
      ? message.content
      : message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
  return text.startsWith("<model-note") || text.startsWith("[Pit] Context");
}
