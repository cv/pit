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

## Testing

- Prefer typed `it.each` tables when cases share setup and assertion shape but vary inputs and expected outputs.
- Give table rows descriptive names; keep lifecycle, concurrency, ordering, and heterogeneous workflows as explicit standalone tests.
- Do not move substantial control flow into table data merely to reduce line count.

- Prefer observable outcomes and effects over implementation tokens, copied prose, private object identity, or incidental call order. Keep exact assertions for meaningful public contracts and safety boundaries; see [the test-contract inventory](docs/test-contract-inventory.md).

## Terminal UX

- Load the [pit-terminal-ux](.pi/skills/pit-terminal-ux/SKILL.md) skill when designing, implementing, or reviewing custom renderers, tool calls/results, progress, errors, or changes to their supporting data contracts.
- Treat faithful inputs/output, consistent semantic outcomes, explicit omissions, and readable error causes as correctness requirements, not optional polish.
- Review representative collapsed, expanded, partial, and final views at realistic terminal widths. Headless tests do not replace live Pi acceptance for behavior changes.

## Delivery

- Load the `pit-delivery` skill for issue implementation and finalization.
- Run `validatePit()` for the standard gates and `preparePitDelivery()` before delivery.
- For TUI, extension-loading, saved-function, sandbox, or partial-update changes: push a non-closing commit, reload Pi, and smoke-test before closing the issue.
- Do not use `Closes #...` until interactive acceptance has passed.
