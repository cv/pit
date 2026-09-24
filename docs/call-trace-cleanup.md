# Small-call trace cleanup

## Design

The A–E probes ask what happened, where time went, and whether two independent operations overlapped:

- A returns `42` without host calls.
- B reads `.gitignore`.
- C reads `.gitignore` and `.oxfmtrc.json` concurrently.
- D computes `2 + 3` using `bc`.
- E counts both files with concurrent `wc -l` processes, then sums with `bc`.

Collapsed results expose complete small scalars and stdout, and identify homogeneous file reads. Expanded results retain the full value and submitted inputs. Process commands, retained tails, call completion, and duration are grouped through explicit provenance rather than duplicated dashboards. Invocation phase timings are secondary expanded diagnostics. Partial views retain active work and nonzero processes even when older completed calls fall outside the live budget. Legacy unlinked progress and orphaned progress remain separately inspectable.

No new controls or shell replacement are introduced. The Pi tool box, shared terminal sanitization, and width-aware wrapping remain authoritative. Domain warnings/errors still propagate independently of capability transport completion. Trace arguments remain type/size summaries; this change does not begin logging argument values.

## Retained contracts

`details.timings` contains `totalMs` and a sparse `phases` record. A monotonic clock partitions the invocation into formatting, preparation, validation, compilation, execution, commit, and result construction. Missing phases did not run. Interrupted phases are included on failure. Snapshots are copied and settlement freezes timing. Sandbox execution includes executor startup, guest work, host calls, and shutdown; capability durations overlap it and must not be added to the total. Named-definition preparation and commit can themselves perform validation; phase labels describe their enclosing operation, not a CPU profile. Timing excludes Pi's outer event handling/rendering and the final progress flush.

Recorded totals survive session replay. Old sessions retain the existing live/replay clock fallback rather than acquiring invented historical durations. Fast capability durations are displayed in milliseconds.

`ShellProgress.traceSequence` refers to the host dispatch sequence, not the guest RPC ID or the independent process counter. An async-local host scope propagates that identity across concurrent work. One capability may own multiple process entries. Missing links are never reconstructed from coincidentally equal IDs or source text. Linked processes remain individually inspectable instead of being collapsed into a method-only count.

The graph consumed by compilation is the graph produced by successful validation. The existing cache key still includes source, registry definitions, input, definition scope, validation mode, available names, and invalid definitions. Cached graphs are copied before use. Commit-time revalidation, grants, and layered override checks remain intact.

Source formatting shares bounded in-flight/completed requests between execution and display. Oversized sources are not cached; formatter failures remain retryable. Summary-only rendering avoids body highlighting for file reads, generic shell results, multiline values, and their compound wrappers. Specialized domain adapters retain their existing behavior; this is not a wholesale renderer rewrite.

## Measurements

Isolated `prepareSandboxProgram` measurements used the same A–E sources and 17 project functions, five paired uncached/cached samples per case. Medians in milliseconds:

| Case | Before uncached | After uncached | Before cached | After cached |
| ---- | --------------- | -------------- | ------------- | ------------ |
| A    | 48.64           | 40.17          | 5.79          | 1.98         |
| B    | 48.92           | 34.46          | 4.41          | 1.89         |
| C    | 36.77           | 37.62          | 3.49          | 1.81         |
| D    | 32.36           | 29.06          | 3.41          | 1.95         |
| E    | 36.64           | 32.13          | 3.64          | 2.01         |

These small, separate-process samples are indicative, not end-to-end speed guarantees. Cached preparation improved consistently; uncached measurements remain noisy and C did not improve. Compiler-host/library caching and executor pooling are deliberately deferred pending further profiling.

The original host traces showed B at 3 ms, C spanning 2 ms, D at 68 ms, and E spanning 140 ms. They excluded preparation and sandbox overhead. A had no host trace at all. Workspace logical-line counts differ from `wc -l` newline counts; neither contract changes here.

## Acceptance

Automated coverage exercises phase partitioning and settlement, pure/save-only/failure/timeout tool paths, concurrent process attribution with displaced counters, changed/removed/invalid dependencies, input-type cache invalidation, formatting sharing/retry/bounds, summary/detail outcome parity, legacy/orphaned progress, nested/multiple processes, live nonzero visibility, replay timing, retained diagnostics, and 60/80/120-column views.

Live acceptance uses the isolated offline provider's `trace-a` through `trace-e`, plus success, nested, progress, failure, timeout, and cancellation fixtures. No real model service or user credentials are needed. Headless assertions do not certify transcript scrolling, expansion, theme changes, selection, or actual interruption; record those separately after the non-closing push/reload.
