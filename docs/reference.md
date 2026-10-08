# Reference

[Documentation index](README.md) · [Usage guide](usage.md)

This page describes the public tool and its global functions. For exact TypeScript declarations, see the generated [global contract](../src/generated/global-contract.d.ts). Saved definitions and their effective signatures can also be inspected through [`functions.getSaved`](#functions).

## Tool parameters

| Parameter    | Contract                                                                                                                      |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `code`       | Required TypeScript expression or named function declaration; no imports or Node globals                                      |
| `params`     | Optional JSON input supplied as the second function argument, whose type must be annotated                                    |
| `label`      | Optional short description of the action for the terminal                                                                     |
| `functionId` | Optional dotted identity for a named definition; its leaf must match the declaration name; not valid on anonymous submissions |
| `saveOnly`   | Validate and save a named function without executing; cannot be combined with `params`                                        |
| `timeoutMs`  | Invocation deadline in milliseconds, 1–300,000; default 30,000                                                                |

Destructure every direct dependency in the first parameter. A function using none may omit parameters, or use `({})` when it also takes input. Return a JSON-compatible value. Host functions are asynchronous.

The tool schema gives `params` an explicit JSON type for every kind of value, so clients send objects and arrays as JSON rather than as encoded strings. If a client still sends a JSON string, Pit decodes a string holding a JSON object or array when the declared input type does not accept strings; a program that declares a string input receives the string unchanged. Clients that sample arguments against a strict JSON schema send `null` for options the model left out, so a `null` value for `params`, `label`, `functionId`, `saveOnly`, or `timeoutMs` counts as omitted.

## What Pit can do

Pit injects only the functions that submitted code requests.

| Namespace   | Purpose                                                                                      |
| ----------- | -------------------------------------------------------------------------------------------- |
| `workspace` | Read, search, list, create, edit, and delete files with bounded results and revision checks. |
| `git`       | Run common Git operations without shell interpolation.                                       |
| `npm`       | Run scripts, tests, installs, audits, package checks, and package queries.                   |
| `gh`        | Work with GitHub issues, pull requests, Actions runs, releases, and the GitHub API.          |
| `shell`     | Run a shell command or an argument-safe executable call with output limits.                  |
| `http`      | Send an HTTP request and receive a bounded response body.                                    |
| `ui`        | Ask for confirmation, text, or a selection, and show notifications.                          |
| `context`   | Inspect the active Pi and Pit context.                                                       |
| `session`   | Inspect session metadata, context usage, and model-visible context; manage its display name. |
| `commands`  | List extension, prompt-template, and skill slash commands with provenance.                   |
| `models`    | List configured models, inspect the current model, and select a model.                       |
| `runtime`   | Inspect runtime state.                                                                       |
| `functions` | Inspect definitions across scopes and manage authored functions.                             |
| `tools`     | Call tools from other extensions and MCP servers as typed functions.                         |
| `toolIndex` | Search and describe the tools available under `tools`.                                       |

See [Global function reference](#global-function-reference) for method details.

## Global function reference

### `workspace`

- `read(file, { format?: "hashed" | "raw", offset?, limit? })` reads a file. Hashed format is the default and includes edit-ready anchors and a whole-file revision; it returns at most 2,000 lines and Pi's 50 KB output budget, marking a shortened read `truncated`. Raw format is data for a program: it returns the whole file, or the lines that `offset` and `limit` select, up to 4,000,000 bytes, and fails rather than return part of a larger selection.
- `read(file, { ranges: [[start, end], ...] })` reads up to 20 line ranges in one call. They come back hashed, sorted, and merged where they meet, with one revision, and share a hashed read's 2,000-line and 50 KB budget; `truncated` marks a cut.
- `viewImage(file)` attaches a local image to the successful tool result. See [image viewing and limits](usage.md#view-workspace-images).
- `edit(file, { revision, changes, context? })` applies revision-checked anchored or file-level changes. With `context: n` (0–20), the result's `ranges` hold the hashed lines around each change, for a follow-up edit without a read; at most 200 lines per edit and 400 per batch, with `rangesTruncated` when cut.
- `batch(operations, options?)` runs a homogeneous read batch or edit batch and returns ordered `{ results }`. Only read batches accept `{ failure?: "fail-fast" | "settled" }`; mixed batches are rejected.
- `search(query, options?)` returns bounded matches with revisions, anchors, and context. Regex matching is interruptible.
- `list(path?)` lists directory entries.
- `glob(patterns?, options?)` returns deterministic bounded matches and truncation metadata.
- `stat(path)` returns file metadata.

### `git`

- `status(args?, options?)` runs `git status`.
- `diff(args?, options?)` runs `git diff`.
- `log(args?, options?)` runs `git log`.
- `add(args?, options?)` runs `git add`.
- `commit(args?, options?)` runs `git commit`.
- `show(args?, options?)` runs `git show`.
- `push(args?, options?)` runs `git push`.
- `tag(args?, options?)` runs `git tag`.

Arguments follow the fixed subcommand without shell interpolation. Use `shell.execFile("git", ...)` for other Git subcommands.

### `npm`

- `run(script, args?, options?)` runs a package script with argument-safe arguments.
- `test({ args?, coverage?, ...options }?)` runs the `test` or `coverage` package script.
- `install(packages?, { dev?, exact?, packageLockOnly?, ignoreScripts?, ...options }?)` installs dependencies.
- `audit({ omitDev?, ...options }?)` requests bounded JSON audit output.
- `outdated(options?)` requests bounded JSON outdated-package output.
- `pack({ dryRun?, ...options }?)` requests JSON package metadata and uses a dry run by default.

Use `shell.execFile("npm", ...)` for unsupported npm commands. npm lifecycle scripts run with the permissions of the Pi process. Use `ignoreScripts` when an install must suppress them.

### `gh`

- `issueList(options?)`, `issueView(number, options?)`, `issueCreate(input)`, `issueComment(number, body, options?)`, and `issueClose(number, options?)` manage issues.
- `prList(options?)` and `prView(number, options?)` inspect pull requests.
- `prCreate(input)` and `prMerge(number, { method, deleteBranch?, auto? })` open and merge pull requests without interactive prompts: a missing body is sent empty, and the merge method is required.
- `runList(options?)` and `runView(id, options?)` inspect GitHub Actions runs and jobs.
- `releaseView(tag?, options?)` and `releaseCreate(tag, input)` inspect and create releases.
- `api(endpoint, args?, options?)` is a bounded, argument-safe escape hatch.

List and view methods return structured JSON and accept `json` to select fields. List methods expose common typed filters, while supported workflows accept argument-safe `args` for other CLI options. Applicable methods also accept `repo`; use `shell.execFile("gh", ...)` only for unsupported GitHub CLI commands.

### `shell`

- `exec(command, options?)` runs a command through the shell.
- `execFile(program, args, options?)` runs a program with an argument array.

Git, npm, and shell process methods support `cwd`, `timeoutMs`, `raise`, `maxBytes`, `maxLines`, and `truncate`. Each stream keeps 50 KB and 2,000 lines by default; a program that parses large output can raise `maxBytes` to 4,000,000 and `maxLines` to 1,000,000. Only the program's return value reaches the model, and Pi's output budget bounds it. A nonzero exit is result data by default. Set `raise` to `true` to make a nonzero exit stop the function.

### `http`

- `request(url, { method?, headers?, body?, maxBytes? })` sends an HTTP request and returns a bounded body.

### `ui`

- `confirm(title, message)` asks for confirmation.
- `input(title, placeholder?)` asks for text.
- `select(title, options)` asks for one selection.
- `notify(message, level?)` shows a notification.

UI methods require a mode that provides a UI.

### `context`

- `get()` returns the working directory, mode, model, thinking level, session file, effective/user/project/session function names, and user/project enablement.

### `session`

- `info()` returns the session ID, file, display name, entry counts, leaf ID, context usage, and `cache`, the prompt-cache state. `cache.state` is `warm` while the idle time since the last request or Pi `cache_warm` refresh is under the model's `promptCache` lifetime for the retention tier Pi requests (`long` with `PI_CACHE_RETENTION=long`, otherwise `short`), `cold` after that, after a compaction, or after a request by another model, and `unknown` when the model has no lifetime for the tier. It also reports `idleSeconds`, `ttlSeconds`, and `refreshedBy` (`request` or `warming`). During a tool call the current request has just refreshed the cache, so it usually reads `warm`.
- `getName()` returns the session display name.
- `setName(name)` sets the session display name.
- `compact(instructions?)` awaits manual compaction and returns bounded cut-point and token metadata without returning the generated summary.
- `outline(options?)` pages the model-visible entries on the active branch in context order. Each entry reports its role, tool, estimated tokens, `reprefillTokens` (what the provider re-prefills when that entry changes, under the caching mode described below), edit state, and whether the model may edit it. Options filter by `roles` and `tool`, page with `after` and `limit` (1-200, default 50), and size previews with `previewChars` (0-2,000, default 200). Prompt and tool system messages are not listed. The outline also reports the `cacheMode` its estimates assume and the same `cache` state as `info()`.
- `inspectEntry(id, options?)` pages the original content of an active-branch entry by character `offset` and `limit` (default 20,000, at most 40,000), including entries that were elided, summarized, or compacted. Edited entries also return their current visible text. Thinking blocks and images are omitted.
- `elide(ids, options?)` stages replacing up to 200 entries with stubs that point to `inspectEntry`. A tool result, from any tool, becomes a stub such as `[Elided by the model · ~4.2K tokens · reason: stale log · original: session.inspectEntry("c3d4e5f6")]`. An assistant entry with tool calls keeps its text, thinking, and each call's ID and name; only each call's arguments become `{ elided: "[Pit: these arguments were elided to save context; this is not the original call · ~2.1K tokens · original: session.inspectEntry(\"a41f09c2\")]" }`, so tool results still answer their calls and signed thinking still replays. Old programs and the file contents they wrote are often most of a long coding session's context. The optional `reason` is one line of at most 200 characters. An entry no larger than its stub, and an assistant entry without tool calls, are rejected.
- `summarize({ from, to, summary })` stages replacing a closed range of completed agent turns with a summary the model writes. The range starts at an assistant entry, keeps each tool call with its result, and contains no user messages, notes, other extensions' messages, or the running turn. The range's first assistant entry keeps its tool calls and carries the summary, its results become elision stubs, and the rest of the range is omitted, so tool calls stay paired and roles still alternate. The summary must be smaller than the entries it replaces and at most Pi's compaction-summary budget, `min(0.8 × reserveTokens, model output limit)`: 13,107 tokens with default settings. A range containing an earlier summary absorbs it, so a lossy summary can be replaced, and `inspectEntry` on the range's first entry lists every entry it covers.
- `setNote(key, content)` stages a keyed working note, sent to the model as `<model-note key="…">` and shown in the transcript. Each change appends one entry at the end of context and leaves earlier entries unchanged, so the provider keeps its cached prefix: a replacement is marked `version="n" replaces="earlier"`, and `null` appends a `removed` entry. `session.notes()` lists only each key's newest version, and `session.outline()` marks older entries `superseded`. Superseded entries stay in context until a rewrite drops them: an elide or summarize in the same batch drops them (with a prefix cache, only those after its earliest change), and a new version that would put every visible version over the note budget drops them itself and reports `droppedEntries`. A removed key's entries always drop together. Keys are 1-64 letters, digits, `.`, `_`, or `-`. A branch keeps at most 32 live notes; live and superseded versions share a budget of the larger of 4,096 tokens and 10% of the context window. Notes are branch-local, and Pit re-appends the newest version of live notes that a compaction summarized away.
- `notes()` lists live notes on the active branch with their entry IDs and tokens, marks keys with a change staged in this turn, and reports the note budget.

Context edits are staged, not applied. They take effect at the end of the current turn, starting with the next model request, and only when the TypeScript call that staged them succeeds; a tree change discards them. A turn can stage each target once.

With `when: "end"`, an elide or summarize waits for the run to end instead, and its receipt reports `appliesAt: "run_end"`. Mid-run the prompt cache is always warm, so an edit there always rewrites it. A deferred edit is applied when the agent settles, so its rewrite falls on the next prompt's request, which often comes after the cache has expired and rewrites the conversation anyway. Its targets stay pending until then. Once context reaches 50% of the window, deferred edits apply at the next turn end instead. A failed call, a tree change, a new session, or a reload discards them. User messages, other extensions' messages, summaries, notes, and the running turn are protected. Edits are one-way for the model: `inspectEntry` reads any original without putting it back in context. Pi records edits as branch-local `context_edit` entries: `/tree` to a point before an edit shows the original again, and raw history, exports, and usage accounting are unchanged. Pit records each applied batch in a `pit.context-edit` entry, which the transcript shows as one row per operation with its token effect; expanded, it lists the entry IDs and the re-prefill estimate. The chat view keeps showing the original messages, because an edit changes only what the model receives.

Re-prefill estimates follow how the active model's provider caches the prompt, which edit receipts, `outline()`, and each operation in a `pit.context-edit` entry report as `cacheMode`. Anthropic Messages, Bedrock Converse, and OpenAI-compatible APIs with Anthropic-style `cache_control`, such as OpenRouter's Anthropic models, cache only at the breakpoints Pi places on the tools, the system prompt, and the last user message (`breakpoints`), so changing any earlier entry rewrites the whole conversation after the system prompt. OpenAI Responses and other Chat Completions APIs reuse the longest unchanged prefix (`prefix`), so they re-prefill from the earliest changed entry to the leaf. Other APIs get the whole-conversation estimate as an upper bound (`unknown`). The whole-conversation figure is Pi's reported context usage less the system prompt when that is known, and never less than Pit's own estimate, because Pi's per-entry estimates count four characters per token and only the visible text of thinking; Pit scales its estimate of the freed tokens by the same measurement. Adding a new note re-prefills only the note in every mode.

When the TypeScript tool is active and context usage first crosses 50% or 75% of the window, Pit appends a short displayed `pit.context-pressure` notice at the end of the turn. In windows larger than 400K tokens, context first reaching 200K tokens also earns a notice, because every request already resends that much; the transcript row names the threshold. The notice reports usage and points to these functions. It is skipped when the turn already applies context edits or was aborted. Earlier notices stay in context because they are small and omitting one would re-prefill everything after it; a compaction that removes them lets the thresholds notice again.

### `commands`

- `list()` returns bounded extension, prompt-template, and skill commands with canonical source information. Built-in interactive commands are not included.

### `models`

- `current()` returns bounded metadata for the active model.
- `list(options?)` returns bounded model metadata and bounded provider refresh diagnostics in `refreshErrors`; available models are the default.
- `set(provider, id)` selects an explicit configured model and fails when credentials are unavailable.

### `runtime`

- `status()` reports mode, idle state, and whether messages are queued.
- `completedCalls(toolCallId, { sequence? })` returns the results of host calls that a failed program completed, so a later program can use them without repeating calls that consumed input, such as a feed, a queue, or a request with side effects. A failed result names its tool call ID and how many calls it can recover. Pit keeps, in memory only, the newest 128 calls and 4,000,000 bytes per program for the 8 most recent failed programs in the Pi session; `omitted` counts completed calls it did not keep. Values are JSON snapshots taken when each call completed. Successful programs keep nothing, and a new Pi session starts empty.

### `functions`

- `list()` lists documented project functions.
- `get(name)` returns project function metadata and source.
- `remove(name)` removes a project function when no function depends on it.
- `listUser()` lists user functions.
- `getUser(name)` returns user function metadata and source.
- `removeUser(name)` removes a user function after interactive confirmation when no function depends on it.
- `listAll({ scope?, allDefinitions?, offset?, limit? }?)` returns `{ functions, total, offset, nextOffset? }`. The default is 50 entries; limit is 1–200. Scope filters include shadowed definitions; `allDefinitions` lists complete chains.
- `getSaved(name, scope?)` inspects an effective or scoped definition, including native globals, provenance, signatures, dependencies, override chains, `$next`, and effects. Check `kind`: only `source` definitions include authored `source`; invalid definitions include diagnostics.
- `planRemoval(name, scope?)` returns the exact removal closure and blockers without mutation.
- `promote(name, summary, options?)` saves a session function to the trusted project by default or to user scope with `{ to: "user" }` after confirmation.
- `removeSession(name, options?)` removes a branch-local function; dependent cascades require `{ cascade: true }`.

### `tools` and `toolIndex`

- `tools.NAME(args?)` calls another Pi tool through Pi's `executeTool()`, with Pi's argument preparation, validation, hooks, and permission checks. Its argument and result types come from the tool's schemas. It returns the tool's structured value when the tool declares an output schema, or its text otherwise; MCP tools return the server's untruncated result. A failed call throws.
- `toolIndex.search(query, limit?)` returns up to `limit` `{ name, summary }` matches ranked by name and description. The default is 8, the maximum 20.
- `toolIndex.describe(name)` returns a tool's description and TypeScript declaration, or `null`.

The usage guide covers [results and omissions](usage.md#call-other-pi-tools).

### Common behavior

Paths are relative to the Pi working directory. Absolute paths are also valid. Workspace mutation results use slash-normalized paths relative to the working directory. A path outside the working directory contains `../` segments in the result.

Output is bounded. Read metadata uses sparse defaults:

- If `offset` is absent, its value is 1.
- If `totalLines` is absent, its value is equal to `lines`.
- If `hasMore` or `truncated` is absent, its value is `false`. Raw reads never return `truncated: true`.

## Limitations

- Wasmtime prebuild installation requires access to GitHub release assets. Without a usable runtime, Pit cannot run TypeScript. See [runtime configuration](configuration.md#runtime-installation) and the [current requirements](../README.md#install-and-update).
- Session functions belong to one session branch.
- User functions are user-local to one Pi agent directory; Pit does not synchronize them across machines.
- Workspace paths are not restricted to the current project.
- Shell commands are not restricted by an allowlist.
- The `git` namespace allows specific subcommands, but it does not restrict their arguments, hooks, remotes, or network destinations.
- HTTP requests are not restricted by a host allowlist.
- Multi-file edit rollback is best effort and is not atomic.
- Returned content, shell output, HTTP bodies, glob results, and search results have limits.
- Workspace search skips binary files and files larger than 1 MB. It searches at most 2,000 files per call.
- The sandbox is an application boundary, not a container or virtual machine. See the [security model](security.md) for trust boundaries and [architecture](architecture.md#sandbox-and-rpc-boundary) for internal resource budgets.
- Saved-function source quotas, nesting, and scope rules are described in [saved functions](saved-functions.md).
- `tools` omits Pit's own `typescript` tool, Pi's `codemode` and `tool_search` tools, Pi's file and shell built-ins, and tools whose identifiers collide. It doesn't return a non-MCP tool's `details`, or MCP content other than text and images.
- With Pi 0.99.2 or newer, MCP servers without `direct` tools connect in the background, and their tools are missing from `tools` until they connect ([#207](https://github.com/cv/pit/issues/207)).
