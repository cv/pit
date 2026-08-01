---
name: pit-delivery
description: Implements and delivers Pit issues with typed tools, bounded validation, CI, reload, interactive smoke testing, and issue closure. Use for Pit feature, refactor, release, and issue-finalization work.
---

# Pit delivery

## Implement

1. Read the issue, parent epic, and relevant comments.
2. Inspect current architecture and tests before editing.
3. Use fresh hashed anchors for every mutation. Re-read after edits and formatting.
4. Use top-level params for multiline patches. Simplify immediately after a malformed submission.
5. Prefer typed npm, Git, and GitHub capabilities. Use raw CLI only for unsupported operations.
6. Batch independent reads and probes, but serialize mutations and dependent transitions.

## Validate

Invoke the trusted project function:

```ts
validatePit({ coverage: true, packageCheck: true })
```

It runs check and tests together, then coverage, then package verification. Do not run full tests and coverage concurrently.

Before delivery, invoke:

```ts
preparePitDelivery({ coverage: true, packageCheck: true })
```

Review its Git status and diff check. Format only changed files.

## Finish an issue

For non-interactive changes:

1. Validate.
2. Review `git.diff(["--check"])` and `git.status(["--short", "--branch"])`.
3. Commit with tests and the closing keyword.
4. Push, verify CI, update the epic, and confirm a clean synchronized worktree.

For TUI, extension, reload, saved-function, sandbox, progress, or renderer behavior:

1. Validate.
2. Commit and push **without** `Closes #...`.
3. Ask the user to run `/reload`.
4. Exercise live partial state and expanded final state interactively.
5. Test relevant success, warning, failure, concurrency, nesting, cancellation, or timeout cases.
6. Correct observed mismatches and revalidate.
7. Make the final closing commit only after observed acceptance.
8. Push, verify CI, update the epic, and confirm a clean synchronized worktree.

## Failure recovery

- Anchor/revision failure: re-read; do not guess another anchor.
- TypeScript tool syntax failure: move content to params and reduce nesting.
- Two failures of one class: stop varying syntax and split the workflow.
- Truncated machine output: aggregate in the capability or saved function before parsing it.
