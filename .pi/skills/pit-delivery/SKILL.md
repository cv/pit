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

## Implement

1. Read the issue, parent epic, and relevant comments.
2. Inspect current architecture and tests before editing.
3. Use fresh hashed anchors for every mutation. Re-read after edits and formatting.
4. Use top-level params for multiline patches. Simplify immediately after a malformed submission.
5. Prefer typed npm, Git, and GitHub capabilities for one-off operations not covered by a project helper. Use raw CLI only for unsupported operations.
6. Batch independent reads and probes, but serialize mutations and dependent transitions.

## Choose project helpers

Use only the helpers relevant to the current phase:

```ts
runPitTargetedTests({ files: ["test/example.test.ts"] })
reviewPitChanges()
inspectPitCoverageGaps({ files: ["src/example.ts"] })
formatPitChanges()
auditPitCodeQuality({ limit: 25 })
```

- Use `runPitTargetedTests()` during the implementation loop, not the full suite after every edit.
- Use `reviewPitChanges()` before validation and after substantial corrections.
- Use `inspectPitCoverageGaps()` after coverage has generated its HTML report.
- Use `auditPitCodeQuality()` for broad feature or refactor work where maintainability risk matters.
- `formatPitChanges()` formats only changed supported files and invalidates their anchors. Re-read every written file before another mutation.
- Use `analyzePitSession()` for one session and `analyzePitSessions()` for project-wide workflow trends. These diagnose agent workflow; they do not replace code validation.

For pull-request work, inspect bounded metadata before creating an isolated worktree:

```ts
inspectGitHubPullRequest({ number, repo })
managePullRequestWorktree({ action: "create", number })
```

Always remove a temporary review worktree with `managePullRequestWorktree({ action: "remove", path })` after the review.

## Validate

Invoke the trusted project function once:

```ts
validatePit({ coverage: true, packageCheck: true })
```

It runs check and tests together, then coverage, then package verification. A failed gate includes a bounded diagnostic tail. Read that output before rerunning a gate. Do not separately rerun completed gates or run full tests and coverage concurrently.

Before delivery, inspect Git readiness without repeating validation:

```ts
preparePitDelivery()
```

Review its Git status, unstaged diff check, and staged diff check. Format only changed files. If delivery preparation exposes a change, correct it and rerun only the affected inner-loop checks before one final validation.

## Verify CI

After pushing, locate the workflow run for the pushed commit rather than assuming the newest repository run belongs to it:

```ts
findGitHubRunForCommit({ repo, sha })
```

Select the exact matching run ID, then wait with:

```ts
waitForGitHubRun({ id, repo, raise: true })
```

Treat a missing run as a synchronization or trigger problem. Do not wait on an unrelated run.

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
