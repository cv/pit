# Project saved functions

Saved functions expose useful agent operations, not an alternate utility library.
Keep existing public names and inputs compatible; extend the closest intent before
adding another function.

## Abstraction boundaries

- **Inspection** converts host output into domain data. `listChangedGitFiles()` owns
  Git porcelain parsing; `findGitHubRunForCommit()` owns commit/workflow selection.
  Neither mutates the worktree or waits for CI completion.
- **Actions** consume inspected data and perform one operation.
  `formatPitChanges()` owns supported extensions, the formatting limit, and anchor
  invalidation. It does not parse Git output.
- **Orchestration** composes existing operations. `reviewPitChanges()` adds diffs and
  history to `preparePitDelivery()`; `waitForGitHubRunForCommit()` discovers a run
  and delegates completion polling to `waitForGitHubRun()`.
- **Policy** stays in the delivery skill: when to validate, push, reload, accept,
  or close an issue. A saved function should not silently make those decisions.

Keep local calculations local. Do not add a public clamp, JSON parser, or generic
command wrapper merely to eliminate a few repeated lines. A new saved function
needs a distinct reusable intent and a useful typed result. Derive dependent
result types from injected functions instead of copying their schemas.

## Bounds and failure contracts

- Numeric inputs are integers within the ranges their documentation states.
  Fractional, non-finite, or out-of-range values are rejected before any host call
  instead of being silently clamped. The only derived cap is `waitForGitHubRun()`'s
  285-second polling budget: checks that would not fit after the initial delay are
  skipped, and a timeout reports both `attempts` made and `requestedAttempts`.
- Check process truncation before parsing machine output. A partial filename list
  must never become a successful partial mutation.
- `listChangedGitFiles()` preserves literal filenames, uses rename destinations,
  omits deletions, and rejects conflicts or more than 500 paths.
- `formatPitChanges()` rejects more than 100 supported files instead of silently
  formatting the first 100. A failed write may still have changed files: re-read
  every attempted target before editing again.
- `preparePitDelivery().ready` means Git inspection and both whitespace checks
  succeeded with complete output. It does **not** mean tests passed, the worktree
  is clean, or the branch is synchronized. Review excerpts may be truncated
  independently of readiness.
- CI discovery returns at most five matches, newest first. `truncated` means more
  matching runs were omitted; `searchLimited` means the recent-run search window
  was full. Absence from that window is not proof that no run exists. `runName`
  becomes GitHub's workflow filter (a name, file name, or ID), so the window holds
  only that workflow's runs; an unknown workflow fails rather than returning
  `found: false`.

## Session analysis and jq

`analyzePitSessions → analyzePitSession → readPitSessionEvents → jq` keeps four
separate responsibilities: session discovery/aggregation, TypeScript audit policy,
session-schema projection, and external query execution.

- Install **jq 1.6 or newer** on PATH to use session auditing or run its integration
  tests. There is no fallback to embedded Node scripts. CI's Ubuntu runner includes jq.
- `jq({ file, filter, variables?, rawInput?, nullInput? })` returns `{ values }` for
  a compact JSON result stream. Variables are primitive JSON bindings (`$name`),
  not string interpolation. `rawInput` corresponds to `-R`; `nullInput` to `-n`.
  Filters and paths are argument-safe, but filters are executable jq programs,
  not a security sandbox. Each invocation has a 30-second timeout and rejects
  nonzero exits, invalid JSON, or output beyond 50,000 bytes / 2,000 lines.
- `readPitSessionEvents()` projects physical-line pages. Its small jq query removes
  code bodies, images, and successful tool output before crossing into the guest,
  clips long labels, programs, and errors, and ends a page early after about 40 KB
  of projected events, always keeping at least one line. It does not classify
  failures or generate recommendations. Empty event pages can still have
  `hasMore: true`; continue using `nextLine`.
- `analyzePitSession()` correlates calls across pages, classifies failures, and
  retains only the requested number of recent failure examples. It refuses an
  incomplete audit beyond 100,000 physical lines. The query reads one line past
  each page; it does not slurp the session. Paging reopens and scans past the
  earlier lines, so audits request the largest (500-line) pages, trading extra
  sequential I/O for a stateless, bounded interface.
- As before, audits cover all recorded branches, skip malformed JSONL lines, and
  use heuristic source-text usage counters. They are not active-branch execution
  traces or TypeScript AST analysis. Sessions are expected to remain append-only
  during an audit; paging is not a filesystem snapshot.
- Multi-session discovery uses bounded filesystem globbing, refuses truncated
  listings, selects newest timestamped filenames, and audits at most four sessions
  concurrently. Aggregated failure labels reflect each session's bounded label list.

## Tests

`test/functions/workflow-resources.test.ts` validates contextual types and loads
and reconciles the complete graph. The workflow behavior tests execute repository
source with injected fakes, checking returned contracts, side effects, sequencing,
and failures rather than relying on source-text assertions. Keep both layers.

Persistent edits become live only after `/reload`; validate and smoke-test the
loaded functions before treating a refactor as interactively accepted.
