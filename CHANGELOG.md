# Changelog

Notable changes to Pit are documented here. GitHub release notes remain the authoritative detailed record for each tagged release.

## [Unreleased]

### Removed

- Remove the deprecated Node executor, its fallback, and `PIT_FUNCTION_EXECUTOR`. TypeScript always runs in the Wasmtime/QuickJS runtime; without a usable prebuild, Pit still loads and each run explains how to install one.

### Changed

- Compile the QuickJS guest once per process instead of on every execution. On linux-arm64, a trivial program's steady-state execution drops from about 140 ms to 6 ms.
- Share one set of text budgets and bounding primitives across results, processes, HTTP, reads, failures, progress, and labels, with consistent counted omission markers.
- Render truncated results through their domain view, reporting truncation once and retaining the fitted value in details.

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
- No automatic migration: old files remain untouched. See [the migration guide](docs/function-system-migration.md).

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

[Unreleased]: https://github.com/cv/pit/compare/v0.17.0...HEAD
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
