---
name: pit-context
description: Strategies for managing a long Pit session's context with session.outline, inspectEntry, elide, summarize, setNote, and notes. Use when a context-pressure notice appears, when a task streams more tool output than the context window holds, or before automatic compaction would discard working state.
---

# Manage context in Pit

Every request re-sends the whole visible context. A stale tool result costs tokens on every later request and moves the session toward automatic compaction, which summarizes everything at once and can lose exact values.

## Strategy

1. **Notes first.** Before removing anything, record what you will need later, such as exact codes, keys, counts, balances, and decisions, with `session.setNote(key, content)`. Notes stay visible and survive compaction. Keep one note per topic and replace it as it changes instead of adding a note per fact.
2. **Elide what you have absorbed.** When a tool result's useful content is in a note or no longer matters, elide it with `session.elide(ids, { reason })`. `session.inspectEntry(id)` recovers an elided entry, but re-reading costs tokens, so elide only what you will not need verbatim.
3. **Summarize finished stretches.** `session.summarize({ from, to, summary })` replaces a completed range of turns with your summary. Include every exact value the rest of the task needs.
4. **Batch edits.** Edits apply at the end of the turn. Each one changes the context from its earliest target onward, and the provider must re-read that suffix without its prompt cache (`reprefillTokens`). One batched pass costs one re-read; several small passes cost several.
5. **Weigh old against recent targets.** Editing an old entry re-reads everything after it, so editing recent entries is cheaper. A large old entry is still worth removing when it frees far more over the remaining requests than its one re-read costs.
6. **Act on notices.** `[Pit] Context is N% full` means every request already re-sends that much. Make one batched pass then, instead of waiting for automatic compaction.
7. **Do not churn.** Inspecting entries you elided means you elided too early or your notes are incomplete. Fix the notes.

## One pass

Find the large entries:

```ts
async ({ session: { outline } }) =>
  (await outline({ roles: ["toolResult"], limit: 50, previewChars: 60 })).entries.filter(
    (entry) => entry.tokens > 1000,
  )
```

Then, in one call, record what you need and remove what you have absorbed:

```ts
async ({ session: { setNote, elide } }, input: { note: string; ids: string[] }) => {
  await setNote("task", input.note);
  return elide(input.ids, { reason: "absorbed into the task note" });
}
```
