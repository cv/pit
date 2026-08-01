# Pit agent workflow

## Hashed edits

- Use only revisions and anchors returned by the immediately preceding `workspace.read` or `workspace.search`.
- A successful edit or formatter run invalidates every previous anchor for that file. Re-read before another mutation.
- Never guess a line hash or reuse one from an older result.
- Prefer `workspace.search` for a single edit target and `workspace.batch` for independent multi-file reads.
- Put multiline, regex-heavy, or quote-heavy patch content in top-level `params` on the first attempt.
- After one malformed tool submission, simplify it. After two failures of the same class, split the operation instead of varying the same construction.

## Tool selection

- Use `npm.test()` for the normal suite and `npm.run(script)` for `check`, `coverage`, and `package:check`.
- Use `shell.execFile("npx", ...)` only for targeted executable invocations without a typed capability.
- Use typed Git and GitHub methods whenever supported. One unsupported GitHub step does not justify raw `gh` for supported view/list/comment/close/run steps.
- Use `shell.exec` only when shell syntax is required.

## Parallelism and ordering

- Use `Promise.all` or `workspace.batch` for independent probes.
- Keep same-file mutations, Git mutations, and dependent state transitions sequential.
- Do not run the full test and coverage suites concurrently.
- Format only files changed by the task; never run a broad fixer with unrelated modifications.

## Delivery

- Load the `pit-delivery` skill for issue implementation and finalization.
- Run `validatePit()` for the standard gates and `preparePitDelivery()` before delivery.
- For TUI, extension-loading, saved-function, sandbox, or partial-update changes: push a non-closing commit, reload Pi, and smoke-test before closing the issue.
- Do not use `Closes #...` until interactive acceptance has passed.
