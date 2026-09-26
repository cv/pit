---
name: pit-terminal-ux
description: Designs, implements, and reviews Pit's terminal UX for tool calls, results, expanded views, progress, execution traces, errors, and other custom TUI renderers. Use for renderer work and changes to the data or lifecycle that determine presentation. Defines information-density, correctness, completeness, timeliness, and interactive acceptance requirements.
---

# Pit terminal UX

## Purpose and scope

Make tool activity understandable without requiring the user to interpret the implementation. A renderer is an inspection interface, not decoration for a log dump.

Use this skill when designing, implementing, or reviewing tool-call and result rendering, domain-specific presentations, saved-function activity, execution dashboards, progress, diagnostics, or their supporting data contracts. Read the [review guide](references/review.md) before planning the change. Use [pit-delivery](../pit-delivery/SKILL.md) for validation and delivery; this skill owns UX policy, not another execution workflow.

These are target requirements, not a claim that existing renderers satisfy them. Fix the relevant gaps in the task's scope and report remaining ones. Do not turn a focused change into an unrequested rewrite or invent controls that Pi does not provide.

## Start with the user's questions

Before selecting a component or a format, identify what the user needs to know:

- **Before execution:** What will run, on which target, with which consequential inputs? Is this a query, mutation, or save-only definition?
- **During execution:** What is active, what has finished, and is the view current? Is it waiting, retrying, or making measurable progress?
- **After execution:** What was found or changed? Did the intended operation succeed? What is incomplete, uncertain, or requires action?
- **On inspection:** Can I understand the actual inputs, inspect the available output, and follow a failure to its cause without reconstructing the tool's internals?

Evaluate each design against all six dimensions:

| Dimension           | Required judgment                                                                                                                        |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Information density | Useful information per occupied terminal row, not maximum characters. Keep identity, outcome, and the decisive result easy to scan.      |
| Presentation        | Stable hierarchy, consistent vocabulary, restrained emphasis, readable wrapping, and useful grouping at ordinary widths.                 |
| Correctness         | The display preserves meaning, provenance, scope, ordering where significant, and the distinction between execution and domain outcomes. |
| Timeliness          | Feedback arrives promptly, distinguishes activity from progress, stays stable while streaming, and settles accurately.                   |
| Usefulness          | Show what supports the user's next decision: target, changes, findings, diagnostics, or recovery—not internal bookkeeping by default.    |
| Error clarity       | Make the failed operation, affected target, cause, impact, and supported next step immediately understandable.                           |

Truth, safety, and access to retained information take precedence over compactness. Improve density by removing duplication and using progressive disclosure, not by silently discarding data. Favor shared patterns over a clever format for one capability.

## Shared presentation contract

### Collapsed: orient and report

- Lead with a short action and recognizable target; report the meaningful outcome and a useful count or finding when available.
- Prefer domain counts such as files changed, matches, tests failed, or vulnerabilities over generated-source line counts.
- Keep routine successful activity compact. Do not impose a fixed one-line limit that hides a failure, warning, incomplete output, or target identity.
- Use the same names, status vocabulary, and target identity when expanding. Do not repeat the same summary in both slots merely to fill them.

### Expanded: inspect without losing information

- Expansion must make the invocation and retained result inspectable, not merely enlarge a summary. Label input, result, and diagnostic sections so their boundaries are clear.
- Include consequential call arguments: `params`, source, full function identity, save-only state, and non-default execution options such as timeout. Source that reads `input.file` is not a substitute for the actual input value.
- Put the decisive finding or error before routine execution bookkeeping. Prefer output-first inspection for completed work; if Pi's call/result slots constrain ordering, avoid a large source or trace preamble and make the trade-off explicit.
- Keep source and execution history separately identifiable from returned data. Routine traces should be secondary, not an obligatory dashboard before every successful result.
- A semantic view may summarize data only if all retained, display-safe fields remain reachable through a real supported disclosure or raw view. Until that exists, include a lossless fallback. Never silently drop unknown fields, array entries, nested objects, or empty values.
- Do not claim an inspection control exists until implemented and verified. Any raw view must retain terminal sanitization and applicable redaction; it is not permission to expose secrets or hidden internal state.

### Partial: show current work, not a premature verdict

- Show active work promptly and label unknown completion honestly. A spinner means activity, not a percentage or evidence of progress.
- Distinguish generation, execution, waiting, retrying, cancellation requested, cancelled, timed out, and completed when the underlying state supports those distinctions.
- Preserve operation identity and stable ordering across updates, including parallel and nested calls. Do not make entries jump around whenever one finishes.
- Coalesce routine updates and repeated polls without hiding failures, retries, or materially different calls. Identify aggregated counts and omitted history.
- Keep recent useful output visible without repeatedly appending the entire log or duplicating it in multiple sections. Preserve retained diagnostics on transition to the final view.
- Settle spinners, elapsed time, subscriptions, and timers on every terminal path. Resumed sessions must not invent live work or timing data they do not contain.

## Outcomes and errors are semantic, not cosmetic

Keep three facts distinct: whether the tool invocation completed, whether a subprocess/transport succeeded, and what the domain result means. A fulfilled promise or successful GitHub query does not prove that the queried build passed.

- Use a shared outcome policy for status symbols, labels, emphasis, and parent summaries. Unknown is not success. Colour alone must never carry the distinction.
- Account for documented domain semantics: an outdated-package finding, a no-match result, or an accepted nonzero exit may be informative or a warning rather than an execution failure. Do not infer outcomes from arbitrary numeric fields or treat all stderr as failure.
- Propagate relevant child warnings, failures, and incompleteness through arrays, batches, and named sections. A tolerated or recovered failure can coexist with overall success, but must remain visible and explicitly explained; a blanket green check must not imply every child succeeded.
- Label successful trace transport as completion rather than domain success when that distinction matters. Do not contradict an error body with a success-looking header.
- Consider Pi's outer tool shell as well as Pit's symbols. Do not change execution semantics or throw solely to recolour a box. If the shell cannot reflect a domain warning, make the distinction clear in the content; use a custom shell only with a justified, tested need.

An error presentation should answer, in this order:

1. **What failed and where?** Name the operation, target, and relevant exit/status code.
2. **Why?** Surface the best available cause and decisive diagnostic excerpt before routine traces or wrapper stacks.
3. **What is the impact?** Distinguish no effect, partial completion, attempted rollback, confirmed rollback, and unknown state when known from the result.
4. **What next?** Offer a specific supported recovery action or inspection route. Do not invent causes, claim rollback without evidence, or suggest blindly retrying a mutation.

Preserve useful path/line references and nested function attribution. Treat cancellation and timeout distinctly from an ordinary application error. If a cause is unknown, say so. Never let the renderer's own parsing error mask the original failure.

## Completeness, bounds, and provenance

- Distinguish **empty**, **not returned**, **not yet available**, **redacted**, **display-collapsed**, and **truncated at the source**. They are different states.
- Display-only omission must be labelled with the count/range when known and a working inspection route. If data was never retained, state that it is unavailable and describe a safe narrower query when appropriate; expansion cannot recover discarded bytes.
- Do not present truncated JSON as a complete object. Keep an explicitly incomplete text fallback. Bound successful output and failures deliberately; an arbitrary first-N-lines error preview must not be the only access to retained diagnostics.
- Prefer explicit result provenance to source-code guessing. A helper, alias, projection, or `Promise.all` wrapper must not falsely identify a result. When attribution is ambiguous, use a faithful generic view rather than a speculative domain renderer.
- Format a copy for display. Never mutate execution data, reorder meaningful arrays, or change model-visible content merely to improve the TUI. Keep full identifiers and copyable values inspectable, subject to the existing security policy.

## Composition and density

- Wrapping a value in an array, named object, batch, or saved-function result must preserve its meaning, outcome, completeness notices, and readable indentation.
- Keep target identity with its payload. Do not move essential scalar context into a distant generic `other` section or replace informative field names with unexplained indexes.
- Avoid nested repetitions of outcome, title, path, range, and exit code. One clear owner for each piece of framing is better than multiple competing headers.
- Use tables for comparable records with short stable columns; use labelled sections for heterogeneous or multiline data. Do not force long paths, diagnostics, source, or arbitrary JSON into wide tables.
- Expand small structured values readably. Avoid escaped JSON strings inside JSON and dense one-line nested objects when the user is inspecting content.
- Treat hashes, revisions, invocation IDs, and routine timing as secondary unless they are relevant to the current decision. Clearly label logical lines versus visible rows if reporting either; omit counts that add no value.

## Terminal and implementation discipline

- Read the installed Pi `docs/extensions.md`, `docs/tui.md`, relevant examples, and linked theme/keybinding contracts before implementation. Resolve them from Pi's installed package, not the repository's `docs/`. Use the actual installed APIs.
- Follow Pi's shell padding and call/result composition rules. Use theme tokens, restrained colour, and symbols plus text that remain understandable without colour. Errors and essential content must not be dimmed into unreadability.
- Fit every rendered row to the supplied display width using ANSI-aware, Unicode-aware utilities. Preserve hanging indentation through all nesting paths. Test tabs, wide characters, combining marks, and long unbroken strings; do not measure columns with string length.
- Keep targets identifiable when wrapping. Any shortened identifier must have an inspectable full form. Do not leak machine-oriented line hashes into the primary reading hierarchy without a reason.
- Keep selection, copy, transcript search, scrolling, and expansion usable. Use configured keybinding hints rather than hard-coded shortcuts; do not introduce nested interactions that compete with Pi's row controls without live testing.
- Treat all source, filenames, labels, diagnostics, and process/network text as untrusted terminal content. Use shared sanitization; preserve only explicitly supported styles or links. Raw inspection is not an escape-sequence bypass.
- Keep domain interpretation separate from layout. Reuse shared outcome, section, formatting, and wrapping logic instead of adding a special-case renderer with its own rules.
- Keep rendering deterministic for a captured state. Avoid domain I/O and execution side effects; reuse bounded, cached display formatting off the hot path rather than spawning work on every redraw. Reuse components where appropriate and invalidate caches on data, width, expansion, and theme changes.
- Handle incomplete streaming args, old sessions, absent details, unknown shapes, and malformed structured output without throwing or making the payload disappear. Renderer failure should degrade to a safe faithful fallback, not a misleading success.

## Workflow and acceptance

1. Inspect the producer, retained data, shared renderer, domain adapter, Pi shell, and existing tests—not just the leaf renderer.
2. Write a brief design: user question, primary information, state/outcome mapping, collapsed/expanded/partial hierarchy, completeness strategy, and constraints. Record intentional exceptions and why.
3. Use the [review guide](references/review.md) to build a representative before/after gallery. Reuse existing harnesses and project helpers. Compare density without sacrificing meaning.
4. Apply [pit-test-audit](../pit-test-audit/SKILL.md) when authoring or reviewing assertions. Protect semantic correctness, retained-field visibility, composition, omission notices, and width—not only snapshots or substring matches. Keep lifecycle/concurrency tests explicit; use descriptive typed tables for input/output variations.
5. Use `tests.runTargeted()` for the affected renderer/producer suites during development. Follow [pit-delivery](../pit-delivery/SKILL.md) for dependency diagnosis, final gates, result interpretation, and loaded-versus-disk checks; do not duplicate that execution workflow here. Review actual rendered output, including warning and error paths.
6. After a renderer behavior change, follow the non-closing delivery/reload workflow and exercise it in live Pi. Prefer the [isolated tmux workflow](references/tmux.md) for agent-driven captures, resizing, search, selection/copy, and cancellation when available; do not delegate automatable checks to the user. Headless output cannot certify colour contrast, scroll stability, click/key handling, cancellation, or interaction with the surrounding transcript. State which observations are headless versus interactive.

The tmux workflow's project functions start and stop the isolated Pi (`ux.manageSession`), submit prompts or keys and capture the pane (`ux.runCase`), run fixtures in new sessions and summarize their outcomes (`ux.runFixtures`), and read a row's styles for theme checks (`ux.inspectRowStyle`). They refuse sockets outside their own runs. Always stop the session, and give runs a 300000 ms tool timeout:

```ts pit-example
async ({ ux: { manageSession, runFixtures } }, input: { fixtures: string[] }) => {
  const session = await manageSession({ action: "start" });
  if (session.action !== "start") throw new Error("expected a started session");
  try {
    return await runFixtures({
      socket: session.socket,
      target: session.target,
      fixtures: input.fixtures,
    });
  } finally {
    await manageSession({ action: "stop", socket: session.socket, root: session.root });
  }
}
```

Do not accept a renderer because it looks attractive on one happy-path value at 200 columns. Accept it when users can reliably understand what happened, inspect what matters, and recover when it did not work.
