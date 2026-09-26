---
name: pit-delivery
description: Implements and delivers Pit issues by orchestrating trusted project functions for bounded review, validation, CI, reload, interactive smoke testing, and issue closure. Use for Pit feature, refactor, release, and issue-finalization work.
---

# Pit delivery

## Operating model

This skill owns workflow policy: sequencing, judgment, acceptance criteria, and recovery. Trusted project functions own repeatable execution and bounded result shaping.

- Call an existing project helper by name instead of recreating its internal npm, Git, GitHub, coverage, or session-analysis workflow.
- Compose helpers when a phase needs more than one operation, but keep dependent mutations serialized.
- Do not create a same-named session override for a project helper during delivery.
- If a helper is unexpectedly unavailable, inspect `context.get()` and `functions.getSaved(name)`. Repair the trusted project configuration or helper rather than silently maintaining a duplicate workflow in this skill.
- If helper behavior must change, update its file under `.pi/functions/` and its tests; keep this skill focused on when and why to invoke it.
- When adding, promoting, renaming, or changing a helper, review its owning skill's trigger, preconditions, result interpretation, and recovery path in the same change. Do not create another registry or copy every function into every skill.
- Editing a helper file does not refresh the active definition. `functions.getSaved(name)` describes the loaded definition; disk-based tests describe the file. After helper edits, use `/reload`, inspect the effective scope/override chain, and smoke-test the changed behavior before claiming live acceptance. Reload also refreshes changed skills and prompt templates.

## Implement

1. Read the issue, parent epic, and relevant comments.
2. Inspect current architecture and tests before editing. When writing, changing, or reviewing tests, load [pit-test-audit](../pit-test-audit/SKILL.md) and apply its authoring gate. For renderer, progress, diagnostic, or presentation-data changes, load [pit-terminal-ux](../pit-terminal-ux/SKILL.md) and use its design and acceptance criteria throughout the work.
3. Use fresh hashed anchors for every mutation. Re-read after edits and formatting.
4. Use top-level params for multiline patches. Simplify immediately after a malformed submission.
5. Prefer typed npm, Git, and GitHub capabilities for one-off operations not covered by a project helper. Use raw CLI only for unsupported operations.
6. Batch independent reads and probes, but serialize mutations and dependent transitions.

## Choose project helpers

Use only helpers relevant to the current phase. Discover names and signatures with `functions.listAll({ scope: "project", limit: 20 })`, following `nextOffset` as needed, and inspect relevant definitions with `functions.getSaved(name)`. Use `Promise.allSettled` for optional availability probes so a missing helper does not hide the other diagnostics.

Blocks marked `ts pit-example` are complete tool programs checked against the project registry by the resource tests. They are not executed by those tests. Supply the second argument through tool `params`; examples do not authorize their effects.

For a focused test run:

```ts pit-example
async ({ runPitTargetedTests }, input: { files: string[]; testNamePattern?: string }) =>
  runPitTargetedTests({ ...input, slowest: 5 })
```

- Use `runPitTargetedTests()` during the implementation loop, not the full suite after every edit.
- `runPitTargetedTests()` reports failures from Vitest's JSON report. Add `testNamePattern` to rerun one case and `slowest` to measure where time goes.
- Use `commitPitChanges()` only after commit/push authorization. It stages exactly the listed files, refuses unrelated staged changes, and can push the branch. Validation or a skill invocation is not permission to publish.
- Use `reviewPitChanges()` before validation and after substantial corrections.
- Use `inspectPitCoverageGaps()` after coverage has generated its HTML report.
- Use `auditPitCodeQuality()` for broad feature or refactor work where maintainability risk matters.
- `formatPitChanges()` formats only changed supported files and invalidates their anchors. Re-read every written file before another mutation. It cannot see committed files, so run it after the last edit and before `commitPitChanges()`.
- Use `analyzePitSession()` for one session and `analyzePitSessions()` for project-wide workflow trends. These diagnose agent workflow; they do not replace code validation.

For pull-request work, inspect bounded metadata first:

```ts pit-example
async ({ inspectGitHubPullRequest }, input: { number: number; repo?: string }) =>
  inspectGitHubPullRequest(input)
```

When an isolated checkout is needed, use `managePullRequestWorktree({ action: "create", number })`. Always remove the temporary review worktree with its returned path through `managePullRequestWorktree({ action: "remove", path })` after review.

### Diagnose dependency-related failures

For missing package APIs, unexpected installed versions, or a recently changed lockfile, inspect before reinstalling or changing source:

```ts pit-example
async ({ inspectPitDependencyInstall }) =>
  inspectPitDependencyInstall({ packages: ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "vitest"] })
```

Read the per-package `issues`, `lockError`, `complete`, and `omitted` fields. `matchesLock: null` means unknown/incomplete, not healthy; narrow the selection or resolve unreadable metadata. `false` calls for diagnosing the reported mismatch, not an automatic install. `true` only compares the selected direct dependencies' metadata/versions with the lockfile; it does not prove semver compatibility, package contents, or unrelated dependencies. Missing optional packages may be intentional.

If synchronization is justified and authorized, use the repository's lockfile-preserving install workflow, then rerun the affected checks. Keep platform-dependent fixture failures distinct from dependency drift and product regressions.

## Validate

Invoke the trusted project function once:

```ts pit-example
async ({ validatePit }) => validatePit({ coverage: true, packageCheck: true })
```

It runs check and tests together, then coverage, then package verification. A failed gate includes a bounded diagnostic tail. Read that output before rerunning a gate. Do not separately rerun completed gates or run full tests and coverage concurrently.

Before delivery, inspect Git readiness without repeating validation:

```ts pit-example
async ({ preparePitDelivery }) => preparePitDelivery()
```

`ready: true` means Git inspection and whitespace checks passed. It does not mean the worktree is clean, tests/CI passed, publication is authorized, or interactive acceptance happened. Review the returned Git status and both diff checks. Similarly, `formatPitChanges({ checkOnly: true })` returning `formatted: false` is a failed formatting check, not successful no-op work. Format only changed files. If delivery preparation exposes a change, correct it and rerun only the affected inner-loop checks before one final validation.

## Verify CI

After pushing, use the existing discovery/wait composition for the exact commit, not the newest unrelated run. Give waiting tool invocations a 300000 ms timeout; a helper's polling budget does not extend the outer tool timeout.

```ts pit-example
async ({ waitForGitHubRunForCommit }, input: { repo: string; sha: string }) =>
  waitForGitHubRunForCommit({ ...input, runName: "ci.yml", raise: true })
```

Use `findGitHubRunForCommit()` alone when only discovery is needed, or `waitForGitHubRun()` when the exact run ID is already known. A missing run is a synchronization/trigger problem; do not wait on another commit's run.

For a pull request, wait for every reported check:

```ts pit-example
async ({ waitForGitHubPullRequestChecks }, input: { number: number; repo: string }) =>
  waitForGitHubPullRequestChecks({ ...input, raise: true })
```

Inspect the returned commit identity, outcome, and merge state; a fulfilled request is not evidence that CI passed when using `raise: false`. When a run fails, call `inspectGitHubRunFailure({ repo, id })` and read its excerpts before changing the workflow or rerunning it. For test jobs, `testFailures` lists each failed Vitest test with its first error line and `testSummary` holds Vitest's totals; `testFailuresOmitted` counts failures that the list or the fetched log window did not include. Distinguish timeouts from assertion failures before deciding whether a change or the runner is at fault.

## Finish an issue

For non-interactive changes:

1. Validate.
2. Prepare delivery.
3. Commit with tests and the closing keyword.
4. Push, verify the exact CI run, update the epic, and confirm a clean synchronized worktree.

For TUI, extension, reload, saved-function, sandbox, progress, or renderer behavior:

1. Validate and prepare delivery.
2. Commit and push **without** `Closes #...`.
3. Ask the user to run `/reload`.
4. Exercise live partial state and expanded final state interactively.
5. Test relevant success, warning, failure, concurrency, nesting, cancellation, or timeout cases.
6. Correct observed mismatches and revalidate.
7. Make the final closing commit only after observed acceptance.
8. Push, verify the exact CI run, update the epic, and confirm a clean synchronized worktree.

## Failure recovery

- Gate failure: read the bounded diagnostic tail before rerunning validation.
- Helper failure: use its structured result and bounded diagnostics before dropping to lower-level capabilities.
- Anchor or revision failure: re-read; do not guess another anchor.
- TypeScript tool syntax failure: move content to params and reduce nesting.
- Two failures of one class: stop varying syntax and split the workflow.
- Truncated machine output: aggregate in the capability or saved function before parsing it.
