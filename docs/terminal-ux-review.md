# Tool renderer UX review

This review applies [pit-terminal-ux](../.pi/skills/pit-terminal-ux/SKILL.md) to Pit's tool-call and result renderer families. It covers `src/renderers/` and their execution, process, timing, and failure-data producers; it is not an audit of unrelated interactive managers.

**Status:** implementation and headless review. Live Pi acceptance remains pending. No claim about live colour contrast, transcript stability, selection, or mouse/keyboard interaction follows from the automated checks.

## Shared design

The user's first question is what happened, not which renderer ran.

- Collapsed rows show intent and a domain-aware result summary. Source/display-line counts no longer crowd these summaries.
- While a call is being prepared or is running, expansion exposes its inputs and current work.
- Once settled, expansion orders the result or error first, then labelled inputs, retained process output, and execution history. The call slot keeps only its header, so source and params are not duplicated ahead of the result.
- Expanded inputs include params, source, function identity, save-only state, and explicit timeout settings. No new inspector, pager, or keybinding is assumed.
- A leaf's domain outcome survives ordinary composition. Recorded execution failures remain visible even if a helper returns an ordinary summary; that warning does not claim a caught failure was unhandled.
- Capability completion is described as completion, not domain success. Pi's outer tool background still reflects invocation success; execution behavior is not changed merely to recolour it.
- Retained, display-safe data is shown inline. Source-level bounds remain in force and are distinguished from presentation. Readability is not purchased by silently discarding fields.

## Audit by family

| Family / modules                                                                                     | Finding and correction                                                                                                                                                                                                                                                                                                           | Verification focus                                                                                                                        |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Call: `typescript-tool-call.ts`                                                                      | Params and explicit timeout were missing. Inputs are now labelled and inspectable; settled source moves after output. Formatting is deferred to input inspection instead of hidden source-line counting.                                                                                                                         | Incomplete args, named/save-only calls, params including multiline patches, settled ordering, async formatting.                           |
| Result: `typescript-tool.ts`                                                                         | Routine traces preceded the useful result and leaf framing repeated the outer summary. Result body now comes first, with metadata retained under the shared summary/body contract. Malformed metadata falls back to retained text/data.                                                                                          | Collapsed/expanded consistency, multiple fallback text blocks, null/undefined, warning/error summaries, output-first composition.         |
| Workspace: `workspace.ts`                                                                            | Search context lost revision/anchor details; nested reads/edits/stats lost metadata; incomplete reads/searches/globs looked fully successful. Metadata remains inspectable and incompleteness is a warning.                                                                                                                      | Reads, context anchors, empty/partial values, edits/deletes, glob/list/stat, full revision and modification metadata.                     |
| Process: `process.ts`, `process/results.ts`                                                          | Nonzero exits and truncated output could have a successful outer marker. Generic JSON stdout was a dense escaped string. Outcomes are shared, complete structured output is readable, incomplete JSON stays text, and significant whitespace is preserved.                                                                       | Quiet success, stderr, failure, truncation, structured and malformed stdout, terminal sanitization.                                       |
| Git: `git-result.ts`                                                                                 | The leaf showed failure while the outer result looked successful. All Git result methods now publish their outcomes; diff/show output preserves trailing spaces rather than trimming them away.                                                                                                                                  | Status, diff, log, add, commit, show, push, tag; known failure and truncation cases.                                                      |
| npm: `npm-result.ts`                                                                                 | Audit remediation, outdated fields, and pack inventory were discarded. Complete payloads now accompany semantic summaries; failing tests lead the test summary, and malformed findings do not turn command errors into warnings.                                                                                                 | Every npm method; packages/fixes, extra fields, multiple packed archives, accepted versus unexpected exits.                               |
| GitHub: `gh-result.ts`                                                                               | Arbitrary API arrays could become blank rows; objects silently stopped after eight fields. Complete objects/arrays now survive, including readable multiline patches. Nested job/check failures influence query outcome.                                                                                                         | PRs, arbitrary API objects, fields beyond eight, failed checks/jobs, plain text, malformed/truncated JSON.                                |
| HTTP: `http.ts`                                                                                      | Error responses and truncated bodies could receive success markers. Outcome reflects status and incompleteness; headers/body remain visible and structured bodies retain their data.                                                                                                                                             | Empty body, 4xx/5xx, complete/malformed/truncated JSON, hostile controls.                                                                 |
| Composition: `generic.ts`, `compound.ts`, `types.ts`                                                 | Wrappers lost child outcomes, scalar context moved to `other`, and batch wrapping lost hanging indents. Parent outcomes aggregate; field order and metadata survive; small scalars stay compact; batch indent maps are propagated. Neutral structured-data rendering does not reinterpret inputs/API JSON as capability results. | Direct, array, named-object, batch, and single-capability helper results; sentinel fields and mixed outcomes.                             |
| Diagnostics: `typescript-failure.ts`, `tool/failure-context.ts`                                      | Expanded errors hid retained tails after 12 lines. The producer also silently cut diagnostic ends and supplied stacks. Expanded views now show all retained diagnostics; bounded capture keeps head and tail with an explicit middle-omission notice. Failure paths and cancellation/timeout labels remain clear.                | Decisive cause at the end, supplied stacks, bounded bytes/lines, long function paths, partial error updates.                              |
| Progress/history: `typescript-progress.ts`, `execution-dashboard.ts`, `execution/dashboard-model.ts` | A second trace-group limit silently hid older failures; the last-four-process preview hid older failures/active work; final views lost retained output. Retained history is inspectable, live previews keep failures/active work, duplicate returned output is not repeated, and final unfinished calls stop looking live.       | Poll grouping, concurrent/nested calls, more than 12 groups, more than four processes, completion, interruption, captured-history limits. |
| Timing: `tool/timing.ts`                                                                             | Row-local timing needed stable storage and restored rows could imply fresh measured execution. State is retained in the shared row; explicit restored rows show unavailable timing; terminal paths stop timers.                                                                                                                  | Live elapsed time, replay, completion, partial error/cancellation, unfinished final traces.                                               |
| Shared/support: `shared.ts`, `hanging-indent-text.ts`, `capability.ts`                               | Existing ANSI-aware hanging indentation remains the primitive; composition now carries its metadata. Shared outcome aggregation avoids divergent wrapper policies. Ambiguous or truncated runtime provenance falls back rather than borrowing a misleading first source call.                                                    | 60/80/120 columns, narrower resize, wide/combining characters, unbroken strings, source hints versus runtime attribution.                 |

## Evidence and reproducibility

- Existing renderer and failure-context suites were extended where expectations encoded duplicated framing or silent omission.
- `test/renderers/ux-contract.test.ts` exercises shared outcome, retained-field, input, composition, error, and sanitization contracts.
- `test/renderers/ux-lifecycle.test.ts` covers output-first composition, fallback, replay, partial/final transitions, process-history retention, and width/theme changes.
- Headless probes used actual Pi dark and light themes at 60, 80, and 120 columns. Representative file reads, command failures, GitHub patches, npm audit results, and compound values stayed within the supplied width. Colour-free excerpts were inspected for ordering and readability; live visual acceptance is still required.

For example, a command returning exit 2 no longer begins with `✓ Command exit 2` and a second `shell exit 2` heading. Its result begins:

```text
✗ Command exit 2
stderr
fatal: permission denied
```

Inputs and execution details follow the diagnostic rather than preceding it. An arbitrary GitHub API array of file patches no longer becomes two empty rows; filenames, patch text, and extra fields remain visible. npm audit no longer substitutes vulnerability counts for package and fix details.

## Deliberate limits and remaining acceptance

- There is no per-result provenance identifier for a multi-capability composite. Such values use a faithful generic presentation instead of speculative Git/npm/GitHub attribution. A single unambiguous capability hint survives wrapping; legacy source hints remain a compatibility fallback only when runtime traces are absent.
- Inline complete payloads and execution history can be longer than the previous lossy views. They are secondary to the decisive output. A separate raw inspector or trace disclosure would need a real interaction design and live acceptance, not a fictitious hint or another silent cutoff.
- Deep unknown structures retain a JSON fallback. Rendering cannot recover upstream-truncated bytes or history that the collectors did not retain. Failure capture still has an 8 KB / 24-line budget, now with explicit head/tail retention.
- Domain warnings/errors remain separate from Pi's invocation-level shell background. This distinction must be checked with the user's actual theme.

After the non-closing review commit is available, reload Pi and verify:

1. An ordinary file read, a params-based call, and a saved-function call, collapsed and expanded.
2. A successful command with stderr, a nonzero command, HTTP failure, and a mixed batch.
3. GitHub arbitrary JSON/patches and npm findings with all expected fields visible.
4. A slow partial update, repeated polling, concurrent/nested work, cancellation, and timeout as applicable.
5. Long errors, retained process tails, source/input access, narrow wrapping, resize, theme change, scrollback, search, and selection/copy.

Record observed mismatches and correct them before merging or claiming interactive acceptance. No closing issue keyword is appropriate before that review.
