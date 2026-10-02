# Changelog

Notable changes to Pit are documented here. GitHub release notes remain the authoritative detailed record for each tagged release.

## [Unreleased]

### Added

- `.pi/pit.json` accepts `paths.project` and `paths.user`, the directories Pit loads saved functions from and promotes them to. They default to `.pi/functions` and `$PI_CODING_AGENT_DIR/functions` (`~/.pi/agent/functions`). Relative paths resolve against the project root and `~` expands to the home directory; either may point outside the project, for example to a separate repository of functions or to one collection of user functions per language.

### Changed

- **Behavior change:** project functions load in every project Pi trusts. The `projectFunctions.enabled` opt-in in `.pi/pit.json` is removed and ignored if present, and `context.get()` no longer returns `projectFunctionsEnabled`. Saving, promoting, and removing project functions need only project trust.

## [0.25.0] - 2026-10-02

### Added

- `session.elide` also accepts assistant entries with tool calls. It replaces each call's arguments with a stub that points to `session.inspectEntry` and keeps the entry's text, thinking, and each call's ID and name. In a long coding session, tool-call arguments were 93% of the assistant side of context, and elide could not shrink them. Provider replay probes through Anthropic Messages (Bedrock) and OpenAI Responses accepted stubbed arguments, including next to signed thinking, and kept the prompt cache up to the first edited entry (#222).

### Changed

- Pit's system prompt is shorter and states each rule once:
  - seven plain guidelines replace eight, and the data guideline gives both budgets, 4 MB for what a program reads and 50 KB for what it returns;
  - the tool description drops repeated injection and anchor rules and says the 50 KB limit applies to returned values;
  - the global function list uses one summary per namespace and now names `runtime.completedCalls`;
  - project and user function catalogs list each function's signature and first sentence, with parameter documentation available from `functions.get(name)`;
  - the `[Session functions: ...]` notice appears only when the list changes, instead of on every result.

  Pit's fixed prompt text falls from about 6,580 to 5,350 characters, and this repository's project catalog from 11,650 to about 6,600. Pi still adds `<rules>` for its built-in tools, whose declarations Pit hides, and a skills hint naming the `read` tool; that needs a Pi change ([earendil-works/pi#10343](https://github.com/earendil-works/pi/issues/10343)).

## [0.24.1] - 2026-10-01

### Fixed

- A program cancelled or timed out while a host call was running no longer reports that call as recoverable. The interrupted call still settled, for example as a shell command that exited with 130, and the completed-call record kept it. A cancelled program showed `↺ Recoverable: 1 completed call`, and `runtime.completedCalls` returned the interrupted result (#211).

## [0.24.0] - 2026-10-01

### Added

- A failed program's completed host calls stay recoverable. Its result says how many calls it completed and how to read them; `runtime.completedCalls(toolCallId)` returns their values, so a later program does not need to repeat calls that consumed input. Pit keeps the newest 128 calls and 4,000,000 bytes per program, in memory, for the 8 most recent failed programs in the Pi session (#211).

### Changed

- In context windows larger than 400K tokens, Pit adds a context-pressure notice when context first reaches 200K tokens, before the 50% and 75% notices. Notices record the threshold that fired, the transcript row names a token threshold, and `sessions.analyze()` counts notices by threshold, such as `50%` or `200K` (#220).
- The context-management guideline says which entries `session.elide` and `session.summarize` accept and points to `session.inspectEntry`. A rejected elide names the IDs that can be elided, and a rejected summarize suggests a valid nearby range when there is one (#221).
- **Behavior change:** a raw `workspace.read` returns the whole file by default, up to 4,000,000 bytes, and fails when the selection is larger instead of returning a shortened copy that a parser could mistake for the file; pass `offset` and `limit` to read part of it. Process methods accept `maxBytes` up to 4,000,000 and `maxLines` up to 1,000,000, so a program can capture and parse large output; the defaults stay 50 KB and 2,000 lines. Hashed reads and the model-visible result keep Pi's 50 KB budget (#210).

## [0.23.1] - 2026-10-01

### Changed

- The usage guide documents calling other Pi tools from TypeScript: finding them with `toolIndex`, injecting them from `tools`, what results contain and leave out, and when to prefer them over `workspace`, `gh`, `http`, and `shell`. The reference covers `tools` and `toolIndex`, the custom-functions guide covers functions that inject tools and their `(unavailable)` state, and troubleshooting covers a missing tool (#193).

### Fixed

- Host calls stopped because their program was cancelled or timed out show as `⚠ cancelled` or `⚠ timed out` in the execution view, instead of `✗ failed`. They no longer count toward "N calls failed so far" or add "execution had failures" to a cancelled result. A call that fails on its own while the program runs still shows as failed.

## [0.23.0] - 2026-09-30

### Added

- Models can manage their own context with branch-local `session.*` globals (#198):
  - `session.outline()` pages the model-visible entries on the active branch with their tokens, re-prefill cost, edit state, and whether the model may edit them. `session.inspectEntry(id)` pages an entry's original content, including elided, summarized, and compacted entries.
  - `session.elide(ids)` replaces tool results with stubs that point to `session.inspectEntry`. `session.summarize({ from, to, summary })` replaces a closed range of completed turns with a summary the model writes; the range's first assistant entry keeps its tool calls, so calls stay paired and roles still alternate. Edits are one-way for the model: `session.inspectEntry` reads any original, and `/tree` to a point before an edit reverts it.
  - `session.setNote(key, content)` keeps a keyed working note at the end of context, and `session.notes()` lists live notes. Notes share the larger of 4,096 tokens and 10% of the context window, and Pit re-appends notes a compaction summarized away.
  - Edits are staged and apply at the end of the turn, only when the call that staged them succeeds. Pi records them as `context_edit` entries, so `/tree` to an earlier point shows the originals and raw history, exports, and usage are unchanged. User messages, other extensions' messages, summaries, and the running turn are protected.
  - The transcript shows notes and a row for each applied edit with its token effect. Tool results summarize staged edits, for example `Staged elide of 1 tool result · ~2K tokens freed · applies after this turn`, and list an outline one entry per row.
- When context usage first crosses 50% or 75%, Pit appends a short notice pointing the model to these functions, and the prompt gains one context-management guideline.

### Changed

- Tested with Pi 0.99.2. The Pi development packages and `@earendil-works/pi-codemode` are 0.99.2.

### Security

- `npm audit` still reports `brace-expansion` 5.0.9 (GHSA-q2hr-2g5m-vwhr, GHSA-qhr7-859c-m2p7, GHSA-6j4f-fj2g-mc7p) through Pi 0.99.2's published `npm-shrinkwrap.json`. Pit doesn't ship it: Pi is a development and peer dependency and provides its own copy.

## [0.22.1] - 2026-09-30

### Changed

- The native runtime is built with Wasmtime 49.0.1 (from 48.0.2) and Rust 1.98.1 (from 1.95.0). Updated native crates: `napi` 3.13.0, `napi-derive` 3.6.9, `napi-build` 2.5.0, `futures` 0.3.34, and the QuickJS guest's `wit-bindgen` 0.62.0. Prebuilds for all six platforms are published with this release.
- Smoke-test containers use Debian 13 (`trixie`) images: `rust:1.98-trixie` and `node:24-trixie-slim`.
- Development tooling: Pi packages 0.99.1, Vitest 5.0.3, oxlint 1.86.0, and oxfmt 0.71.0. Dependabot now also tracks Rust crates and container images.
- TypeScript stays at 6.0.3: TypeScript 7 no longer exports the compiler API Pit validates programs with (#196).

### Security

- `npm audit` reports `brace-expansion` 5.0.9 (GHSA-q2hr-2g5m-vwhr, GHSA-qhr7-859c-m2p7, GHSA-6j4f-fj2g-mc7p) through Pi 0.99.1's published `npm-shrinkwrap.json`, which npm honors over Pit's lockfile. Pit doesn't ship it: Pi is a development and peer dependency and provides its own copy. The fix needs a Pi release.

## [0.22.0] - 2026-09-30

### Added

- Programs can inject the Pi and MCP tools Pi lets a `typescript` call use, as typed `tools.*` functions, for example `async ({ tools: { mcp__github__list_issues } }) => ...`. Calls run through `ctx.executeTool()`, so Pi's argument preparation, validation, and hooks apply.
  - Arguments are typed from each tool's schema and checked before the program runs.
  - MCP results are unwrapped to the server's structured content, validated against its schema after undeclared properties are removed, or to its text. Server errors throw with the tool's name.
  - Images a tool returns attach to the result.
  - A nested `terminate` (for example, from pi-goal's `goal_complete`) ends the turn when the program succeeds.
  - `toolIndex.search` and `toolIndex.describe` find tools and show their declarations. `typescript`'s description lists the injectable tools and steers services they cover away from Pit's `workspace`, `gh`, `http`, and `shell`.
- Saved session, project, and user functions can inject `tools.*`. When a tool is missing, for example while an MCP server is disconnected or before servers connect on resume, a function that needs it is kept.
  - Running it, or anything that depends on it, fails before execution with the missing tool.
  - `functions.getSaved`, `functions.listAll`, and `/functions` report it `(unavailable)` rather than `(invalid)`, with the reason.
  - It works again when the tool returns. While the tool is callable, saved calls are checked against its real schema.
- While a call runs, its collapsed view lists the latest running host calls, how many others are running, and how many have failed so far, instead of only `Running...`.
- `workspace.viewImage(file)` attaches local images to a successful TypeScript result using Pi's image recognition and model-aware processing. Image bytes stay outside sandbox JSON; one invocation can attach up to 8 images in call order, with bounded source, per-image, and total encoded sizes, visible image identity and text-only-model warnings, and expanded processing notes.

### Changed

- **Breaking:** Pit requires Pi 0.99 or newer and is tested with Pi 0.99.1. On older Pi versions, which cannot hide tools, Pit warns at startup that other tools stay visible to the model.
- Pit hides other tools from the model instead of deactivating them. The model still sees only `typescript` and any `allowedTools` exceptions, but Pi's built-in tools, extension tools, `codemode`, and `tool_search` stay active, and Pit no longer overrides Pi's `defaultTools` setting. MCP tools configured with `"exposure": "direct"` and tools loaded by `tool_search` stay declared.
- `typescript` is registered with `model-only` exposure. Pi's `codemode` scripts and other tools can no longer call it, and codemode's `only` mode no longer hides it from the model.
- Pit depends on `@earendil-works/pi-codemode` for tool declarations, so `tools.*` identifiers and types match what codemode shows for the same tools.

### Fixed

- Report a saved function's type errors once. Each error also appeared a second time, from Pit's internal `/pit/saved-signatures.ts` copy of the same source.
- Keep tools that MCP, `codemode`, or `tool_search` activated after `/tree` navigation. Pit re-applied an exclusive tool set, which deactivated `codemode` and MCP tools with `direct` exposure.

## [0.21.1] - 2026-09-28

### Changed

- Result renderers recognize namespace results (workspace reads, searches, edits, lists, globs, stats, and batches; HTTP responses; process results) and execution metadata with compiled TypeBox schemas instead of hand-written type checks. A value that matches the same shapes renders exactly as before, and each schema is now the single description of its shape. Pit's one `isRecord` helper replaces duplicated inline object checks.

## [0.21.0] - 2026-09-27

### Changed

- Reorganize documentation around reader tasks: a shorter introduction and quickstart, dedicated usage, saved-function, configuration, reference, security, and troubleshooting guides, and a documentation index. Contributor setup and checks live in `CONTRIBUTING.md`; the case study is explicitly historical and the security policy follows the latest tagged release.
- Pit adds its skills list and its user and project function catalogs to the system prompt as named sections (`pit_skills`, `pit_user_functions`, `pit_project_functions`) instead of replacing the whole prompt. Pi records sections in the session, so a catalog change patches one section and keeps the cached prompt prefix, and prompt changes from later extensions are no longer overridden. When an earlier extension has already replaced the prompt, or on Pi before 0.86, Pit extends that replacement.
- **Breaking:** The root module no longer re-exports `effectiveRegistry`, `reconstructFunctions`, and `validateRegistryCapacity`, which only Pit's tests imported. `GLOBAL_METHODS` remains its public export.

### Fixed

- Declare the tool's `params` argument as any JSON value with an explicit type for each kind (object, array, string, number, boolean, or null) instead of an untyped schema. Some models, such as Claude through an OpenAI Responses gateway, sent every `params` value as a JSON-encoded string, escaping quote-heavy data twice; they now send objects and arrays. Pit still decodes a JSON string for inputs that cannot accept one.
- Accept a function without parameters, such as `async () => 42`, as one that uses no functions; previously Pit rejected it and required `async ({}) => 42`. A first parameter that is not destructured, such as `(_deps, input)`, is still rejected, and the error now names it and suggests `({})`.
- Re-apply Pit's active tools, `typescript` plus any `allowedTools` exceptions, after `/tree` navigation. Pi restores the tool set recorded on the destination branch, which could re-enable other tools or leave `typescript` unavailable.
- Detect an existing skills list from the rendered prompt instead of the selected tools. Pi also lists skills when only `bash` is selected, and when an earlier extension replaced the prompt while `read` was selected, Pit omitted its list and the model received none.
- Treat a `null` optional tool argument (`params`, `label`, `functionId`, `saveOnly`, or `timeoutMs`) as omitted. Clients that sample arguments against a strict JSON schema send `null` for options the model left out; a save-only call then failed with "saveOnly does not accept top-level params", and the call view listed the null options.

## [0.20.1] - 2026-09-27

### Added

- Repository maintainer functions: `pr.editBody` edits a pull request description through literal replacements, checklist ticks, and an appended section, and writes nothing when an expected text is missing or ambiguous. `release.verifyPublished` checks a published release's tag commit and exact asset set, and runs the strict installer from a fresh tag clone.

### Changed

- Repository maintainer functions: `delivery.listChangedFiles({ includeDeleted: true })` also lists tracked deletions and staged rename sources, so its result can be passed straight to `delivery.commit`.
- The release guide lands the version bump through a `release-X.Y.Z` pull request, as `main` requires, and gives the exact strict-installer and isolated tag-install commands.

## [0.20.0] - 2026-09-26

### Changed

- **Breaking:** Injected dependencies are typed as `PitDependencies` and namespace types such as `PitShellFunctions`; the `PitCapabilities` and `Pit*Capability` names are gone. The root module exports `GLOBAL_METHODS` instead of `CAPABILITY_METHODS`, and the contract scripts are `globals:check` and `globals:generate`.
- Guest host calls and retained traces name a `namespace`; the old `capability` field is not accepted. Tool results replayed from older sessions show the raw diagnostic view instead of the structured one.
- Built-in functions come from one catalog of global definitions: 35 native primitives and 28 source globals. `git.*`, `npm.*`, and `gh.*` are now inspectable TypeScript that injects `shell.execFile`, so an override of `shell.execFile` also applies to them and `$next` composes through both layers. Their signatures, argv, validation, and output bounds are unchanged.
- Reflection reports those command globals as `kind: source`, with their source, their `shell.execFile` dependency, and the primitive effects they reach, instead of Git, npm, or GitHub host effects. Errors and traces attribute calls to the global source function, and global source calls no longer create saved-function journals or promotion suggestions.
- The invocation timing summary is one muted line that ranks phases by cost, such as `23ms total: 18ms execution, 4ms validation, 1ms rest`. Malformed retained timing metadata shows the inspectable raw view.
- Test with Pi 0.87.1.

### Removed

- Historical documents from `docs/`: the 0.16 function-system spec and migration guide, and past design, review, and test-audit records. `docs/` now holds the architecture guide, release procedure, and case study. The removed records remain in Git history; the 0.16 guides are at the `v0.16.0` tag.

## [0.19.0] - 2026-09-26

### Added

- Add `gh.prCreate` and `gh.prMerge`. They never prompt: a missing body is sent empty, and `prMerge` requires `method: "merge" | "squash" | "rebase"`.
- Hint when a literal `workspace.search` query that contains regular expression syntax, such as `a|b`, finds nothing: the result's `hint` suggests `regex: true`, and the search view shows it as a warning.
- Explain how to fix a program whose result is not JSON-typed, such as `unknown[]` or `Record<string, unknown>`, after the validation diagnostics.

### Changed

- Repository maintainer functions: `delivery.commit` commits renames that `git mv` already staged, and `tests.probeMutation` can mutate `.pi/functions` sources through the workflow test loader.

### Fixed

- Say where process options go when `npm.run` receives them in place of its script arguments.

## [0.18.1] - 2026-09-26

### Changed

- Organize the repository's project functions into namespaces by operation (`delivery`, `ci`, `pr`, `tests`, `ux`, `sessions`), with names that drop what the namespace says, such as `delivery.validate` for `validatePit` and `ci.inspectFailure` for `inspectGitHubRunFailure`. `.pi/functions/README.md` maps each namespace to its operation and owning skill. New maintainer helpers list failed Vitest tests from CI logs, time runs, jobs, and steps (`ci.inspectTimings`), and keep a terminal shell alive for exit checks.

### Fixed

- Stop a cancelled or timed-out command's descendants too, such as a shell pipeline's processes, which previously kept running after Pit reported the command stopped. Commands now run in their own process group without Pi's controlling terminal, so programs that prompt on `/dev/tty` fail instead of writing into Pi's screen.
- Dismiss a program's `ui.confirm`, `ui.input`, and `ui.select` dialogs when its call ends by cancellation, deadline, or session change; previously they stayed open after the call reported its outcome.
- Ignore user function promotion and removal confirmations answered after their call ended; previously a late Yes still promoted or deleted the function while the transcript recorded only the timeout.
- Name the capability calls that were still running when a call is cancelled or times out, such as `timed out after 3000ms while 1 capability call was still running: ui.confirm`, since their effects may already have started.

## [0.18.0] - 2026-09-25

### Added

- Add project functions for agent-driven terminal acceptance: start and stop an isolated Pi on a private tmux server, run fixtures and cases, and inspect row styles. They refuse any tmux server outside their own runs.

### Changed

- Compile the QuickJS guest once per process instead of on every execution. On linux-arm64, a trivial program's steady-state execution drops from about 140 ms to 6 ms.
- Run coverage and version-independent checks once per CI run, test release runtimes without repeating coverage, and seed native build caches on `main` so pull requests and releases can reuse them.
- Share one set of text budgets and bounding primitives across results, processes, HTTP, reads, failures, progress, and labels, with consistent counted omission markers.
- Render truncated results through their domain view, reporting truncation once and retaining the fitted value in details.

### Removed

- Remove the deprecated Node executor, its fallback, and `PIT_FUNCTION_EXECUTOR`. TypeScript always runs in the Wasmtime/QuickJS runtime; without a usable prebuild, Pit still loads and each run explains how to install one.

### Fixed

- Keep oversized results valid JSON within Pi's output budget, including appended notices: a process result whose output reached its cap no longer collapses to `{`, long strings keep both ends instead of disappearing, and small fields such as exit codes and stderr survive.
- Show a character-safe prefix instead of empty text when a collapsed failure headline or raw read's first line exceeds its budget.
- Keep multi-byte characters whole across process pipe chunks and HTTP byte limits.
- Bound process output while capturing instead of buffering complete streams before truncation.
- Keep bounded tails exact suffixes, so later process output no longer merges into the last retained line.
- Preview collapsed failures with their leading context and decisive tail, such as the last stderr lines of a failed command, around one exact omission count that folds in markers from earlier bounds.
- Count output dropped by live and retained process tails and mark it in progress and execution views.
- Enforce execution deadlines even when a capability handler never settles; previously such a call could keep a tool invocation running past its timeout.
- Attribute capability calls to the correct saved function when saved functions run concurrently.
- Report guest errors by name and message instead of appending a stack frame that pointed into generated code.
- Report a guest's own failure as that failure when the deadline elapsed without interrupting it, and explain programs that await a promise that never settles.
- Refresh stale or unmarked Wasmtime prebuilds on install, and use the latest release's prebuilds for unreleased versions; linux-arm64 prebuilds are no longer committed to Git.

## [0.17.0] - 2026-09-24

### Added

- Allow selected Pi tools alongside `typescript` through a trusted project's `allowedTools` configuration, with case-sensitive names and `*` patterns that respect Pi's tool restrictions.
- Lead npm audit, outdated, and pack results with useful overviews while keeping complete retained payloads inspectable.
- Record monotonic invocation phase timings in `details.timings`, including failed and replayed calls.

### Changed

- Put completed tool output and decisive diagnostics before inputs and execution history in expanded views.
- Preserve semantic outcomes, retained fields, and explicit truncation notices across workspace, process, Git, GitHub, HTTP, and compound results.
- Bound live dashboards with counted omissions while keeping active and failed work visible and exposing all retained calls in the final expanded view.
- Compose trusted project workflows through shared helpers, with jq-backed session analysis, byte-bounded inspection, strict input ranges, and workflow-specific CI discovery.
- Reuse validated dependency graphs and share bounded source formatting between execution and display, reducing cached preparation to about 2 ms in isolated samples.
- Link process progress to its host capability call, keeping concurrent and nested process output attributed without duplicate sections.
- Show small values, stdout, and homogeneous file-read summaries in collapsed results while deferring highlighting of hidden bodies.
- Update the tested Pi integration to 0.86.0 and refresh development dependencies.

### Fixed

- Improve saved-function viewer contrast on dark themes, including scope badges, metadata, and shortcuts.
- Distinguish cancellation, timeout, and interrupted generation without misclassifying source excerpts or inventing execution timing.
- Avoid duplicate retained process output without hiding additional diagnostics or differently interleaved streams.
- Preserve wrapping, hanging indentation, and terminal sanitization through nested and streaming views.
- Explain namespace-capture errors during saved-function resolution more clearly.

## [0.16.1] - 2026-09-18

### Changed

- Reduce fixed model-facing prompt prose from 7,536 to 5,968 characters (20.8%) while documenting layered resolution, promotion, `$next`, paginated inspection, and portable guest constraints.
- Keep calling guidance engine-agnostic and remove repeated tutorials from function catalogs without dropping signatures or useful parameter documentation.
- Measure all prompt parameter descriptions and compile emitted examples in regression tests.

### Fixed

- Stop advertising Node's unavailable `process` global in the portable authoring contract, while preserving direct Node executor security tests.
- Make Wasmtime console methods explicit no-ops, avoiding the native WASI stdio runtime panic without inheriting host output streams. Return diagnostics instead of logging them.

## [0.16.0] - 2026-09-18

### Added

- Inspect native globals, shadowed definitions, provenance, signatures, `$next`, and effect closures through one paginated registry API and read-only-aware function manager.
- Enforce signature-compatible layered overrides and support typed `$next` in session, user, and project definitions, including named execution, promotion, reload, and safe fallback removal.
- Add `functionId` for namespaced session definitions, preserving full identifiers through replay, promotion, catalogs, and traces.
- Build and smoke-test Linux, macOS, and Windows ARM64/x64 Wasmtime addons in CI, attach them to tagged releases, and install only the matching checksum-verified prebuild during Git package installation.
- Propagate external cancellation into Wasmtime through race-safe execution IDs and epoch interruption.

### Breaking changes

- Require explicit method-level dependency injection for built-ins and saved functions; lexical saved-function calls and whole-namespace capture are removed.
- `functions.listAll()` now returns a paginated registry result; `getSaved()` includes native globals and may have no authored source.
- User-owned functions use `user` scope and `${PI_CODING_AGENT_DIR}/functions/`, loaded automatically without enablement configuration.
- Remove legacy user/project path readers and user-global management aliases; user APIs are `listUser`, `getUser`, and `removeUser`, with promotion `{ to: "user" }`.
- Ignore pre-upgrade `pit-functions` session entries. New definitions use branch-local `pit-function-definitions` entries.
- Discover documented functions recursively by canonical path, with bounded reads and collision/symlink checks. Invalid definitions block affected calls instead of silently falling back.
- No automatic migration: old files remain untouched. See [the migration guide](https://github.com/cv/pit/blob/v0.16.0/docs/function-system-migration.md).

### Changed

- Make Wasmtime the default TypeScript function executor.
- Retain the deprecated permission-restricted Node fallback for unavailable or unloadable implicit prebuilds; explicit Wasmtime requests remain strict.

### Security

- Run each submitted program in a fresh fuel-, time-, memory-, call-, and protocol-bounded Wasmtime store with a non-inheriting WASI Preview 2 context.

### Known limitations

- Function-viewer metadata can have low contrast on dark themes; tracked for a follow-up release in [#90](https://github.com/cv/pit/issues/90).

## [0.15.1] - 2026-09-16

### Fixed

- Raise the bounded Vitest timeout to 15 seconds so compile-heavy project integration tests remain deterministic under CI coverage instrumentation.

## [0.15.0] - 2026-09-16

### Changed

- Project functions are now written to `.pi/functions/`; legacy `.pi/pit/functions/` files remain readable, with new-path definitions taking precedence.
- Persistent function scope now comes from storage location or explicit promotion APIs instead of `@pit project` and `@pit global` JSDoc tags.
- Directly submitted named functions always begin session-scoped and require `functions.promote()` or the `/functions` TUI for persistence.
- Pit's trusted project workflow helpers moved to `.pi/functions/`.

### Compatibility

- Existing marked persistent files continue to load; scope tags are ignored.
- Updating a legacy project function writes the new path and removes the old copy. Project removal clears both locations to prevent legacy definitions from resurfacing.

## [0.14.1] - 2026-09-16

### Fixed

- Report timed-out streaming processes with exit code 124 and aborted processes with exit code 130 instead of treating signal termination as success.
- Add bounded timeout and abort diagnostics to process results.
- Escalate to SIGKILL when a child ignores SIGTERM.

## [0.14.0] - 2026-09-16

### Added

- Added an adaptive-music case study with a sanitized session transcript.
- Added bounded model-catalog refresh diagnostics and provider-scoped refresh cancellation.
- Added public project governance, security, contribution, and release documentation.
- Added Node.js 22 and 24 CI coverage, runtime dependency auditing, and automated tagged GitHub releases.

### Changed

- Upgraded the tested Pi integration to 0.85.1 and Vitest to 4.1.11.
- Simplified execution dashboard model construction and reduced maintainability-audit findings.
- Reworked public installation guidance around tagged GitHub distribution while keeping npm publication disabled.

### Fixed

- Rebuilt saved-function viewer highlighting after theme changes.
- Preserved multiline syntax colors across hashed prefixes and TUI line boundaries.
- Resolved all reported npm dependency advisories.

## [0.13.3] - 2026-08-06

- Completed the feature-oriented source reorganization and strengthened architecture boundary checks.

## [0.13.2] - 2026-08-06

- Organized source modules around feature boundaries and reduced root-level coupling.

## [0.13.1] - 2026-08-06

- Simplified saved-function internals while preserving project and session behavior.

## [0.13.0] - 2026-08-05

- Added user-global saved functions and scoped function management.

Earlier release history is available on the [GitHub Releases](https://github.com/cv/pit/releases) page.

[Unreleased]: https://github.com/cv/pit/compare/v0.25.0...HEAD
[0.25.0]: https://github.com/cv/pit/compare/v0.24.1...v0.25.0
[0.24.1]: https://github.com/cv/pit/compare/v0.24.0...v0.24.1
[0.24.0]: https://github.com/cv/pit/compare/v0.23.1...v0.24.0
[0.23.1]: https://github.com/cv/pit/compare/v0.23.0...v0.23.1
[0.23.0]: https://github.com/cv/pit/compare/v0.22.1...v0.23.0
[0.22.1]: https://github.com/cv/pit/compare/v0.22.0...v0.22.1
[0.22.0]: https://github.com/cv/pit/compare/v0.21.1...v0.22.0
[0.21.1]: https://github.com/cv/pit/compare/v0.21.0...v0.21.1
[0.21.0]: https://github.com/cv/pit/compare/v0.20.1...v0.21.0
[0.20.1]: https://github.com/cv/pit/compare/v0.20.0...v0.20.1
[0.20.0]: https://github.com/cv/pit/compare/v0.19.0...v0.20.0
[0.19.0]: https://github.com/cv/pit/compare/v0.18.1...v0.19.0
[0.18.1]: https://github.com/cv/pit/compare/v0.18.0...v0.18.1
[0.18.0]: https://github.com/cv/pit/compare/v0.17.0...v0.18.0
[0.17.0]: https://github.com/cv/pit/compare/v0.16.1...v0.17.0
[0.16.1]: https://github.com/cv/pit/compare/v0.16.0...v0.16.1
[0.16.0]: https://github.com/cv/pit/compare/v0.15.1...v0.16.0
[0.15.1]: https://github.com/cv/pit/compare/v0.15.0...v0.15.1
[0.15.0]: https://github.com/cv/pit/compare/v0.14.1...v0.15.0
[0.14.1]: https://github.com/cv/pit/compare/v0.14.0...v0.14.1
[0.14.0]: https://github.com/cv/pit/compare/v0.13.3...v0.14.0
[0.13.3]: https://github.com/cv/pit/releases/tag/v0.13.3
[0.13.2]: https://github.com/cv/pit/releases/tag/v0.13.2
[0.13.1]: https://github.com/cv/pit/releases/tag/v0.13.1
[0.13.0]: https://github.com/cv/pit/releases/tag/v0.13.0
