# Terminal UX review guide

Use this guide with [pit-terminal-ux](../SKILL.md). It is an acceptance checklist and fixture plan, not a requirement to add every possible test combination to every change.

## Repository map

Paths below are relative to this reference file:

- [Call presentation](../../../../src/renderers/typescript-tool-call.ts): label, submitted source, function identity, generation state.
- [Result composition](../../../../src/renderers/typescript-tool.ts): partial/final/error routing, summary, dashboard, value rendering.
- [Generic routing](../../../../src/renderers/generic.ts), [compound values](../../../../src/renderers/compound.ts), and [renderer types](../../../../src/renderers/types.ts): domain routing, composition, outcome and layout contracts.
- [Renderer directory](../../../../src/renderers/): workspace, process, Git, npm, GitHub, HTTP, wrapping, and diagnostic presentations.
- [Process outcomes](../../../../src/process/results.ts): accepted exit codes and domain findings.
- [Execution model](../../../../src/execution/dashboard-model.ts) and [execution directory](../../../../src/execution/): traces, progress collection, grouping, and bounds.
- [Tool adapter](../../../../src/tool/typescript.ts) and [tool directory](../../../../src/tool/): actual inputs, retained result data, formatting, timing, and failures.
- [Renderer tests](../../../../test/renderers/) and [shared harness](../../../../test/support/extension-fixture.ts): existing probes and fixtures. Do not rely solely on the harness's wide default viewport or colour-free test theme.

Trace any missing information back to its producer. A renderer cannot display fields that were never retained; a data-contract change needs its own correctness and compatibility tests.

## Plan before rendering

For the task under review, record:

- The user's question and likely next action.
- Which operation and target must remain identifiable.
- Which inputs and outputs are actually available; which are bounded, redacted, or absent.
- Expected invocation, process/transport, and domain outcomes, including mixed or recovered results.
- Collapsed, expanded, running, and final layouts; where source and execution diagnostics belong.
- How every retained display-safe field can be inspected, including unknown fields.
- Any new interactions, Pi limitations, or deliberate compromises.

A simple labelled hierarchy is preferable to a new widget unless the widget materially improves this task. Do not design a raw inspector, pager, or subpanel merely by mentioning it in a hint: implement and test the actual access path, or keep the data visible in the existing view.

## Representative fixture matrix

Cover the affected families and their shared composition paths. Include regression cases from this table when changing shared rendering, not just the leaf capability that motivated the work.

| Family            | Representative values                                                                                                      | What must be demonstrable                                                                                                                                               |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Invocation        | Source using `params.file`; multiline patch in params; namespaced saved function; save-only; non-default timeout           | The real target and consequential inputs remain inspectable; saving is not described as execution.                                                                      |
| Workspace         | Empty and paged reads; hashed and raw content; long paths; search context; edit/delete acknowledgement                     | Content is readable, target and range are clear, and pagination is not confused with complete output or an empty file. Do not fabricate a diff from an acknowledgement. |
| Process and Git   | Quiet success; stderr-only success; nonzero exit; diff; truncated head/tail                                                | Status agrees with semantics; diagnostics and diff whitespace are preserved; incompleteness is explicit.                                                                |
| npm               | Failing tests; audit with affected packages/fixes; outdated findings; pack file inventory                                  | Domain warnings are distinguishable from tool failure; actionable details are not replaced by counts alone.                                                             |
| GitHub            | PR with many fields; running/failed workflow; arbitrary API objects; arrays of `{filename, patch}`                         | Unknown shapes remain visible; status is meaningful; no blank array rows or silent eight-field cutoff.                                                                  |
| HTTP              | Empty success; structured body; malformed JSON; 4xx/5xx; truncated body                                                    | Transport status, body, headers, and completeness remain understandable; a returned error response is not labelled simply successful.                                   |
| Generic values    | Null/undefined; false/zero; empty containers; single/multiline strings; unknown fields; deep structures                    | Empty values stay distinct; adding a newline or unfamiliar field does not erase context or unpredictably change meaning.                                                |
| Composition       | The same value directly, in an array, in a named object, in a workspace batch, and through a helper                        | Identity, domain meaning, outcome, retained details, and hanging indentation survive wrapping.                                                                          |
| Mixed outcomes    | One failed batch member; caught/recovered error; warning inside successful query                                           | The summary reflects unresolved problems and explains tolerated failures without erasing evidence.                                                                      |
| Diagnostics       | Long compiler error; decisive cause at the end; nested failure path; error after partial mutation                          | Cause and impact are prominent; retained diagnostics are accessible; rollback/retry claims are evidence-based.                                                          |
| Lifecycle         | Incomplete args; slow work; repeated polling; concurrent/nested calls; timeout; cancel; resume                             | Current work is clear, updates are stable, relevant history survives settlement, and timing/animation terminates.                                                       |
| Limits and safety | More trace groups than the display budget; upstream truncation; unknown totals; redacted values; hostile terminal controls | Every omission is honest; failures do not vanish silently; no unsafe escape sequences or secret exposure through raw view.                                              |

Use real representative shapes as well as synthetic edge cases. A friendly fixture that contains only the fields a renderer already recognizes will miss the most important data-loss bugs.

## Inspect at realistic sizes

Render at **60, 80, and 120 columns**. Check narrower widths for safe degradation in shared layout utilities. Review dark and light themes, and ensure colour-free output still communicates the outcome.

For each before/after example, record:

- The first meaningful information and how many rows precede it.
- Total occupied rows, duplicated headings/metadata, and avoidable wrapping.
- Whether the primary target and result can be recognized in a normal transcript viewport.
- Whether the underlying inputs and results remain inspectable without guessing.
- Which checks are automated, headless visual inspection, or live Pi observations.

These measurements support judgment, not a universal row quota. An extra row that makes a failure actionable is useful density; saving rows by dropping its cause is not.

## Regression assertions

Prefer reusable contract checks over an ever-growing collection of renderer-specific substring expectations:

- Outcome and completeness agree between leaf, parent summary, and visible markers.
- Unknown fields and every retained payload have a verified display or inspection path.
- Long arrays, objects, error text, and trace histories have correct omission notices when bounded.
- Direct and wrapped forms preserve semantic meaning, target association, and continuation indentation.
- Each rendered line fits the supplied visible width, including ANSI styles and Unicode.
- Rendering does not mutate the payload; malformed inputs degrade safely without hiding the original diagnostic.
- Re-rendering after resize, theme change, expansion, progress, completion, cancellation, and timeout does not reuse stale state or continue timers.

Use sentinel fields and a diagnostic cause near the end to detect silent loss. Include a nested warning/error rather than testing only success. Check actual rendered rows and colours where relevant; a JSON snapshot of the input is not a renderer test.

## Live acceptance

Follow `pit-delivery` for the validation, non-closing push, reload, and acceptance sequence when renderer behavior changes. Prefer an [isolated tmux Pi instance](tmux.md) with the supplied offline fixture provider so the agent can drive the real TUI without model requests or access to the user's credentials and active conversation pane. Reserve user requests for subjective preferences or checks that cannot be automated. In live Pi:

1. Compare collapsed and expanded views in the surrounding transcript, not an isolated screenshot.
2. Observe a slow partial update through completion and an interrupted operation through cancellation/timeout as applicable.
3. Inspect success, warning, failure, mixed results, nested calls, and retained diagnostic access.
4. Resize, change theme, expand/collapse, scroll back, search, and select/copy representative content. Exercise any new key or mouse controls.
5. Confirm that settled or resumed entries remain truthful and stable and that the outer tool shell does not obscure domain warnings.

Report what was actually observed. Do not mark live acceptance passed based on headless tests, and do not close a behavior-change issue until observed mismatches are resolved.

## Review verdict

Treat lost inputs/output, false success, hidden failure causes, unsafe terminal text, or incorrect lifecycle state as correctness blockers. Treat duplicate framing, inconsistent grouping, wasted rows, and unnecessary interaction as UX defects rather than cosmetic polish.

A useful review records: user-visible symptom, affected state and width, reproducible fixture, responsible layer, proposed correction, and acceptance evidence. Approve intentional exceptions explicitly; do not lower the shared contract to match an existing bug.
