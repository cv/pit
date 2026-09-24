# pit

**One typed tool for Pi, instead of a toolbox.**

Pit is an extension for the [Pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent). It swaps Pi's built-in tools for a single `typescript` tool. Rather than reading a file, running a command, and making an edit in three separate turns, the model writes one small TypeScript function that uses the capabilities it needs, and only that function's return value comes back.

```ts
async ({ workspace: { read }, git: { status: gitStatus } }) => {
  const [manifest, status] = await Promise.all([
    read("package.json", { format: "raw" }),
    gitStatus(["--short"]),
  ]);

  const pkg = JSON.parse(manifest.content);
  return {
    package: pkg.name,
    scripts: Object.keys(pkg.scripts ?? {}),
    status: status.stdout,
  };
}
```

That call reads a file and checks Git status in parallel, then returns a three-field summary, not two raw outputs.

## Why try it

- **Fewer round trips.** Related reads, commands, and edits, plus the logic between them, fit in one call.
- **Quieter context.** Intermediate output stays inside the call; only the returned value reaches the model.
- **Earlier feedback.** Each call is type-checked before it runs, so a misspelled method or bad argument is reported with its line and column before anything happens.
- **Reusable workflows.** A call that works can be saved as a typed function and reused later in the session, across a project, or in all your projects.

Each call runs in a fresh Wasmtime/QuickJS sandbox with no direct access to files, the network, or processes. It can affect the host only through the capabilities it asks for, and results are bounded so the context and TUI stay compact.

It's a different way of working, and it won't suit every setup. When a session starts, Pit makes `typescript` the only active coding tool, even if Pi's `defaultTools` setting lists others (you can [allow specific tools](#allow-other-tools)). Everything the model does goes through TypeScript.

For a longer first-hand account, see [I Wasn't Trying to Build an App](docs/case_study/), a case study of growing a music-recommendation system through everyday Pit use.

## Install

Pit needs Node 22.19 or newer and is tested with Pi 0.86.0; other Pi versions may work.

Install the latest version:

```sh
pi install git:github.com/cv/pit
```

This tracks `main`, where releases are cut from; changes land there only after CI passes. To update, run `pi update git:github.com/cv/pit`, then `/reload` in Pi (or restart it).

Other ways to install:

```sh
# Try it for one session without changing your settings
pi -e git:github.com/cv/pit

# Install for the current project only (writes .pi/settings.json)
pi install -l git:github.com/cv/pit

# Pin a release (package updates won't move a pinned install)
pi install git:github.com/cv/pit@v0.17.0
```

See [Releases](https://github.com/cv/pit/releases) and the [changelog](CHANGELOG.md) for what changed between versions. Pit is distributed from GitHub only; it isn't published to npm.

Pit uses a prebuilt Wasmtime addon for Linux, macOS, or Windows on ARM64 or x64. Without one, it warns and falls back to a deprecated, permission-restricted Node executor.

> [!IMPORTANT]
> Pi extensions run with your user's permissions, so review the source before installing. Pit sandboxes the code the model writes, but the capabilities it exposes can still change files, run commands, and reach the network.

## What Pit can do

Pit injects only the capabilities that submitted code requests.

| Capability  | Purpose                                                                                      |
| ----------- | -------------------------------------------------------------------------------------------- |
| `workspace` | Read, search, list, create, edit, and delete files with bounded results and revision checks. |
| `git`       | Run common Git operations without shell interpolation.                                       |
| `npm`       | Run scripts, tests, installs, audits, package checks, and package queries.                   |
| `gh`        | Work with GitHub issues, pull requests, Actions runs, releases, and the GitHub API.          |
| `shell`     | Run a shell command or an argument-safe executable call with output limits.                  |
| `http`      | Send an HTTP request and receive a bounded response body.                                    |
| `ui`        | Ask for confirmation, text, or a selection, and show notifications.                          |
| `context`   | Inspect the active Pi and Pit context.                                                       |
| `session`   | Inspect session metadata and manage its display name.                                        |
| `commands`  | List extension, prompt-template, and skill slash commands with provenance.                   |
| `models`    | List configured models, inspect the current model, and select a model.                       |
| `runtime`   | Inspect runtime state and request confirmed reload or shutdown.                              |
| `functions` | Inspect and remove trusted project functions.                                                |

See [Capability reference](#capability-reference) for method details.

## Build a call

Submitted code must be a TypeScript expression. It cannot contain imports.

Use an anonymous function for one-time work:

```ts
async ({ context: { get } }) => {
  return { cwd: (await get()).cwd };
}
```

Pit contextually types destructured capabilities. Capability annotations are not necessary. Validation detects unknown capabilities, unknown methods, invalid arguments, missing awaits, and incompatible result values. Diagnostics include source locations.

### Pass large data in `params`

Use top-level `params` for large patches, generated file contents, commit messages, and other quote-heavy data. The second function parameter must have a type annotation:

```json
{
  "code": "async ({ workspace: { edit } }, input: { file: string; contents: string }) => edit(input.file, { revision: null, changes: [{ kind: 'replaceFile', content: input.contents }] })",
  "params": {
    "file": "src/generated.ts",
    "contents": "export const generated = true;\n"
  }
}
```

Top-level `params` work with a one-time function and with the first execution of a named function.

### Control concurrency

Capability calls are asynchronous. A call starts when the function invokes the capability method. Pit waits for outstanding calls before it accepts a successful result.

Use `Promise.all` when all independent operations must succeed. Use `Promise.allSettled` or a local `catch` when an operation is optional. Sequence dependent operations. Do not run conflicting mutations in parallel.

This call preserves the successful Git result when an optional file does not exist:

```ts
async ({ workspace: { read }, git: { status: gitStatus } }) => {
  const results = await Promise.allSettled([
    read("optional.config.json", { format: "raw" }),
    gitStatus(["--short"]),
  ]);
  return results.map(result => result.status === "fulfilled"
    ? { ok: true, value: result.value }
    : { ok: false, error: String(result.reason) });
}
```

Unknown capabilities and methods fail closed at run time.

## Edit files safely

Hashed reads are the default. Each selected line contains a line number, a short hash, and its content. The result also contains a revision for the complete UTF-8 file:

```text
41:k3F9q|function example() {
42:7Qa2m|  return true;
43:p91Xs|}
```

An edit must use the current revision and current line anchors from `workspace.read` or `workspace.search`:

```ts
async ({ workspace: { edit } }) => edit("src/example.ts", {
  revision: "J8xM2pQa7vL4",
  changes: [
    { kind: "replace", start: "42:7Qa2m", content: "  return false;" },
    { kind: "insertAfter", anchor: "43:p91Xs", content: "export { example };" },
  ],
});
```

`replace` and `delete` apply to anchored line ranges. If the end anchor is absent, the change selects one line. `insertBefore` and `insertAfter` add content at an anchor. `replaceFile` rewrites a file. `deleteFile` deletes a file.

File creation requires `revision: null` and one `replaceFile` change. A rewrite or deletion of an existing file requires its current revision.

Pit validates all anchors against the supplied revision. It rejects overlapping changes. It applies compatible changes from the bottom of the file to the top. It converts inserted `\n` characters to the dominant line ending and preserves untouched bytes.

A successful edit invalidates all earlier revisions and anchors for that file. Read or search the file again before the next edit.

A read batch supports `fail-fast` and `settled` failure handling. An edit batch must target unique files. Pit validates every edit before the first write. If a later write fails, Pit makes a best-effort attempt to restore files that it already changed. A multi-file edit batch is not an atomic filesystem transaction.

## Reuse a workflow

Use a named top-level function for work that can recur:

```ts
async function runTests({ npm: { test } }, input: { coverage?: boolean } = {}) {
  return test({ coverage: input.coverage, raise: true });
}
```

Pit validates and runs the function. It saves the function only after execution succeeds.

Set `saveOnly` to `true` to validate and save a function without execution. A save-only definition cannot use top-level `params`:

```json
{
  "code": "async function runChecks({ npm: { test } }) { return test({ raise: true }); }",
  "saveOnly": true
}
```

Supply top-level `params` when the first execution needs input:

```json
{
  "code": "async function inspect({ workspace: { read } }, input: { file: string }) { return read(input.file, { format: 'raw' }); }",
  "params": { "file": "README.md" }
}
```

Call a saved function through explicit dependency injection:

```ts
async ({ runTests }) => runTests()
```

```ts
async ({ runTests }) => runTests({ coverage: true })
```

Directly submitted named functions become session functions. They survive reloads and follow the active session branch. A replacement is rejected if it invalidates a dependent function.

Saved functions can call other saved functions. Pit injects only referenced functions and their transitive dependencies into each restricted process. Types remain available across calls. Nested calls have a maximum depth of 32.

The effective registry resolves session, then project, then user, then immutable Pit global definitions. User-authored source has these limits; built-ins do not count toward them. The registry has these limits:

- 64 functions.
- 100 KB for one function.
- 1 MB of combined saved source.

Successful tool results include a compact, compaction-safe catalog of active session-function signatures. Effective user and project functions are documented in the system prompt instead of being repeated in every result. Catalogs contain only complete signatures and report omitted entries when they reach the output budget. `context.get().savedFunctions` also lists all effective names.
Pit tracks only in-memory invocation counts by function name; it does not retain arguments, source, or results as usage telemetry. After five invocations in one loaded branch lifecycle, a non-temporary session function receives one bounded suggestion to use `functions.promote(name, summary)`. User functions, project functions, session overrides, and names that look temporary are excluded. Reload and session-tree navigation reset counts and suggestion state.

### Namespaced session functions

Set the optional `functionId` tool parameter to give a named definition a dotted identity:

```json
{
  "functionId": "company.check",
  "code": "async function check({}, input: { value: number }) { return input.value * 2; }",
  "params": { "value": 21 }
}
```

The final identifier segment must match the declaration name. Anonymous submissions cannot set `functionId`. Omitting it keeps the declaration name as the identity. Namespace collisions, reserved segments, and attempts to override sealed registry-management functions are rejected before saving.

Invoke the definition with nested injection:

```ts
async ({ company: { check } }) => check({ value: 21 })
```

`company.check` and `other.check` are separate definitions even though both declare `check`. Use the full identifier for inspection, removal, and promotion. Promoting `company.check` writes `company/check.ts` in the selected persistent directory without renaming the declaration. Reload and branch navigation preserve the full identity.

### Compatible overrides and `$next`

An override must accept the lower definition's arguments and return a compatible result. Pit checks the public call signature without the first dependency parameter, including optional/rest argument requirements. Incompatible definitions fail before a session entry or persistent file is changed. Use a new identifier for a breaking contract; annotate generic return types when preserving a type-parameter relationship is important.

Declare `$next` to invoke the next lower implementation of the same identifier:

```json
{
  "functionId": "context.get",
  "code": "async function get({ $next }) { const result = await $next(); return { ...result, cwd: result.cwd + '/decorated' }; }",
  "saveOnly": true
}
```

`$next` is definition-relative: session → project → user → global, skipping absent layers. Its arguments and result are typed from the lower implementation. An anonymous program cannot declare `$next`, and a definition with no lower implementation is invalid. Ordinary dependencies remain virtual and use the active highest-layer definition.

Persistent files may declare `$next` too. Promotion re-resolves it relative to the destination: moving a session decorator to project storage changes its next target from the old project definition to the user/global definition. If no valid lower target remains, promotion is rejected without replacing the file or removing the session definition.

Removing an override reveals a lower definition only if the resulting chain remains valid. A required `$next` target cannot be deleted out from under a dependent override. Host grants include only effects reachable at execution; a lower implementation used solely for signature checking does not add authority.

### Reuse user functions

User functions load automatically from `${PI_CODING_AGENT_DIR}/functions/` (default `~/.pi/agent/functions/`). No user enablement flag is required, and project configuration does not disable user functions. Global functions are immutable built-ins owned by Pit, not files owned by the user.

Use `functions.promote(name, summary, { to: "user" })` or **Save to user scope** in `/functions`. User promotion and removal require interactive confirmation. Promotion rejects project- or session-only dependencies; promote stable dependencies first. At invocation, dependencies resolve virtually against session, project, user, and global layers.

Files have one documented function declaration and canonical path-derived identifiers: `company/check.ts` declares `check` and is injected as `company.check`. Alternate dotted filenames, case-only collisions, and leaf/namespace collisions are rejected. Discovery is bounded; symlinked subdirectories are not followed and symlinked function files are rejected. Invalid definitions reserve their identifier so calls cannot silently fall back to a lower implementation. Fix or explicitly remove the invalid definition, then reload external edits.

Upgrading from a version before 0.16? User functions moved, and the old `globalFunctions` settings and global-management APIs were removed. See the [migration guide](docs/function-system-migration.md).

### Allow other tools

Pit activates only `typescript` by default. Add explicit exceptions in a trusted project's `.pi/pit.json`:

```json
{
  "allowedTools": ["goal_*"]
}
```

Names are case-sensitive; `*` matches any sequence. Pi's tool restrictions still apply. Empty or invalid configuration grants no exceptions. Run `/reload` after changes.

This controls startup selection only; other extensions can change active tools afterward.

### Share trusted project functions

Project functions are disabled by default. Enable them only for a trusted project in `.pi/pit.json`:

```json
{
  "projectFunctions": {
    "enabled": true
  }
}
```

Use `functions.promote(name, summary)` or **Save to project** in `/functions` to persist a session function. Pit writes a documented source file like this:

```ts
/**
 * Runs repository tests.
 *
 * @param input.coverage - Enable coverage.
 */
async function runTests({ npm: { test } }, input: { coverage?: boolean } = {}) {
  return test({ coverage: input.coverage, raise: true });
}
```

If the definition already has a JSDoc block, the summary replaces that block's summary paragraph; other paragraphs and tags such as `@param` are kept.

Project functions use the same execution rules as session functions. Pit commits a function after successful execution, or after static validation when `saveOnly` is `true`.

Pit stores project functions as readable TypeScript files in `.pi/functions/`. Legacy `.pi/pit/functions/` files are ignored and left untouched. Scope comes from storage location, not a source marker. A named definition submitted directly creates a session override; promote it explicitly to update the project version and clear that override.

Pit loads project source only after explicit opt-in and Pi's project-trust check. The function still runs in the same restricted process as a session function.

Use `functions.list()`, `functions.get(name)`, and `functions.remove(name)` to manage project definitions. Use `functions.listUser()`, `functions.getUser(name)`, and confirmed `functions.removeUser(name)` for user definitions. Use `functions.listAll()` and `functions.getSaved(name, scope?)` to inspect effective or explicitly scoped functions, including dependencies, dependents, and override state. Use `functions.planRemoval(name, scope?)` to inspect an exact removal closure without mutation. Session removal rejects dependent cascades unless `functions.removeSession(name, { cascade: true })` explicitly opts in. Use `functions.promote(name, summary)` to save a session function to the project or pass `{ to: "user" }` for confirmed user persistence. Persistent removal remains blocked when saved functions depend on the target. Disabling project functions does not delete existing source files. User functions load automatically.

### Manage all function definitions

Run `/functions` to open the interactive manager. It includes built-in globals as well as user, project, and session definitions. Authored definitions appear first; **Filter scope…**, **Show all definitions**, and page controls expose lower, shadowed definitions without flooding the display.

```text
/functions list
/functions list global
/functions list all
/functions show workspace.read global
/functions show company.check user
/functions delete runTests
```

Inspection shows implementation kind, effective scope, origin, public signature, override-chain paths, resolved dependencies, `$next`, and direct/transitive effects. Native globals show package-owned metadata—not invented source—and have no mutation actions. All registry-management `functions.*` globals are sealed. Invalid persisted definitions show loading diagnostics; fix their files and reload. Invalid attempts to override sealed globals do not disable those management functions.

Select a session definition to inspect it, promote it, or delete it. Project and user removal act on the selected writable scope, never on a global beneath it. `/functions delete` remains a session-only, confirmed branch-local deletion with explicit dependent-cascade handling.

Programmatic inspection uses the same registry:

```ts
async ({ functions: { listAll, getSaved } }) => {
  const page = await listAll({ scope: "global", limit: 10 });
  const read = await getSaved("workspace.read", "global");
  return { total: page.total, nextOffset: page.nextOffset, names: page.functions.map(fn => fn.name), read };
}
```

`listAll()` returns `{ functions, total, offset, nextOffset? }`, not an array. Its default page size is 50, with a maximum of 200. By default it lists effective definitions; `allDefinitions: true` includes shadowed layers. A scope filter selects definitions from that scope, whether effective or shadowed.

### Reflect on reusable work

Pit packages a `/pit-reflect [focus]` prompt template. It reviews work completed in the current session, compares recurring workflows with the effective saved-function registry, and makes only high-confidence additions or improvements. It prefers extending or composing existing functions, keeps unproven helpers session-scoped, and reports when no new function is justified.

## Understand execution

Pit completes these steps for each call:

1. It contextually type-checks the submitted TypeScript.
2. It compiles the TypeScript to JavaScript.
3. It creates a fresh Wasmtime store and QuickJS runtime inside the extension process.
4. It injects only the resolved function dependencies and queues requested host effects.
5. It dispatches bounded host requests concurrently and returns their completions to QuickJS.
6. It returns the resolved JSON-compatible value to the model.

The Wasm guest receives no inherited filesystem, environment, network, arguments, or stdio. It must use an injected function for host effects.

Failed TypeScript calls still use Pi's required thrown-error path and remain `isError: true`. Pit enriches the final result through `tool_result` middleware with a bounded root error, saved-function path, function activity, and redacted capability traces. Expanded TUI failures show the function path and execution dashboard. Non-function failures keep an empty path and concise error text.

The generated capability contract is in [`src/generated/capability-contract.d.ts`](src/generated/capability-contract.d.ts). Authoritative method declarations, arity limits, model summaries, TUI descriptions, and result-renderer keys are in [`src/capabilities/registry.ts`](src/capabilities/registry.ts). Public host dispatch is exhaustive over the registered capability names. A new capability requires a host implementation before TypeScript checks pass.

## Read results in the TUI

The Pi TUI shows a compact call description during generation and execution. A spinner identifies active work, and the row shows live durations.

Press `Ctrl+O` to expand a tool row. The expanded row shows submitted source and the retained result. Pit does not show injected saved-function source in tool output.

Pit uses compact structured renderers for common capability results. Compound objects can show recognized values as named sections. Unknown values use syntax-highlighted JSON. Git results use Git-aware summaries and styling while they preserve the serialized result.

Expanded running rows show a live capability dashboard in source order. Each entry shows the capability, method, state, and duration. Project and session functions include their scope. While running, the dashboard keeps running, failed, and rejected calls plus the 12 most recent call groups, and a counted notice replaces older completed calls; the finished expanded view lists every retained call. Long-running shell calls show a sanitized, bounded tail of standard output and standard error. Partial updates do not enter the final model context.

Each invocation retains at most 128 runtime capability traces for TUI attribution. A trace records names, source order, timing, duration, and outcome. Argument metadata contains bounded type-and-size summaries, not argument values. Additional calls set a truncation flag. Traces let saved-function results use the same renderers as direct calls. Ambiguous multi-call results use generic rendering.

Display formatting changes only the TUI. It does not change the serialized tool result.

## Security model

Authored functions use a portable JavaScript contract: standard language globals, bounded `setTimeout`, and `console.log/warn/error`. Node globals such as `process`, `require`, and `Buffer` are not part of that contract, including when using the Node fallback; use injected functions for host operations. Wasmtime discards console output without accessing host stdio—return structured diagnostics when they need to be visible.

Submitted TypeScript runs in a fresh QuickJS runtime inside a bounded Wasmtime store:

- The Wasm component has no inherited filesystem, environment, network, arguments, or stdio.
- The guest cannot start subprocesses, workers, or native addons.
- Each invocation receives a fresh store, QuickJS runtime, fuel budget, memory limit, and wall-clock deadline.
- Explicit cancellation advances the execution epoch and interrupts guest code.
- Guest requests, host responses, total calls, and concurrent calls are bounded.

Filesystem, command, HTTP, and UI effects are available only through host-authorized injected functions. Calls and protocol frames have size and concurrency limits. Timeout and cancellation signals propagate to both Wasmtime and cooperative host operations.

The sandbox restricts direct access. It does not make host capabilities harmless. The `git` and `shell` capabilities run commands with the permissions of the Pi process. Git hooks and Git network operations can have external effects. Workspace methods accept absolute paths and paths outside the working directory. The `http` capability can request any destination that the host can reach.

Capability destructuring makes intent visible. It is not an approval boundary. Review generated calls before execution when an operation can affect sensitive data or systems.

This isolation is stronger than `node:vm`, which is not a security boundary. Wasmtime runs through a native addon in Pi's process, so a native runtime defect can still crash the host. It does not replace a container, virtual machine, or operating-system sandbox. If you use a hostile model or a multi-tenant workload, use an additional operating-system boundary.

Report suspected vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Capability reference

### `workspace`

- `read(file, { format?: "hashed" | "raw", offset?, limit? })` reads a bounded selection. Hashed format is the default and includes edit-ready anchors and a whole-file revision.
- `edit(file, { revision, changes })` applies revision-checked anchored or file-level changes.
- `batch(operations, { failure?: "fail-fast" | "settled" })` runs a homogeneous read batch or edit batch. Mixed batches are rejected. Both modes return `{ results }`.
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
- `runList(options?)` and `runView(id, options?)` inspect GitHub Actions runs and jobs.
- `releaseView(tag?, options?)` and `releaseCreate(tag, input)` inspect and create releases.
- `api(endpoint, args?, options?)` is a bounded, argument-safe escape hatch.

List and view methods return structured JSON and accept `json` to select fields. List methods expose common typed filters, while supported workflows accept argument-safe `args` for other CLI options. Applicable methods also accept `repo`; use `shell.execFile("gh", ...)` only for unsupported GitHub CLI commands.

### `shell`

- `exec(command, options?)` runs a command through the shell.
- `execFile(program, args, options?)` runs a program with an argument array.

Git, npm, and shell process methods support `cwd`, `timeoutMs`, `raise`, `maxBytes`, `maxLines`, and `truncate`. A nonzero exit is result data by default. Set `raise` to `true` to make a nonzero exit stop the function.

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

- `info()` returns the session ID, file, display name, entry counts, leaf ID, and context usage.
- `getName()` returns the session display name.
- `setName(name)` sets the session display name.
- `compact(instructions?)` awaits manual compaction and returns bounded cut-point and token metadata without returning the generated summary.

### `commands`

- `list()` returns bounded extension, prompt-template, and skill commands with canonical source information. Built-in interactive commands are not included.

### `models`

- `current()` returns bounded metadata for the active model.
- `list(options?)` returns bounded model metadata and bounded provider refresh diagnostics in `refreshErrors`; available models are the default.
- `set(provider, id)` selects an explicit configured model and fails when credentials are unavailable.

### `runtime`

- `status()` reports mode, idle state, and whether messages are queued.

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

### Common behavior

Paths are relative to the Pi working directory. Absolute paths are also valid. Workspace mutation results use slash-normalized paths relative to the working directory. A path outside the working directory contains `../` segments in the result.

Output is bounded. Read metadata uses sparse defaults:

- If `offset` is absent, its value is 1.
- If `totalLines` is absent, its value is equal to `lines`.
- If `hasMore` or `truncated` is absent, its value is `false`.

## Limitations

- Wasmtime prebuild installation requires access to the tagged GitHub release assets. Missing or unsupported prebuilds fall back to the deprecated Node executor. Pit requires Node 22.19 or newer as the Pi extension host.
- Session functions belong to one session branch.
- User functions are user-local to one Pi agent directory; Pit does not synchronize them across machines.
- Workspace paths are not restricted to the current project.
- Shell commands are not restricted by an allowlist.
- The `git` capability allows specific subcommands, but it does not restrict their arguments, hooks, remotes, or network destinations.
- HTTP requests are not restricted by a host allowlist.
- Multi-file edit rollback is best effort and is not atomic.
- Returned content, shell output, HTTP bodies, glob results, and search results have limits.
- Workspace search skips binary files and files larger than 1 MB. It searches at most 2,000 files per call.
- The sandbox is an application boundary, not a container or virtual machine.

## Troubleshooting

### Pi reports an unsupported Node version

Run `node --version`. Install Node 22.19 or newer. Start Pi again with the new Node version.

### Git cannot install or update the package

Confirm that `https://github.com/cv/pit` is reachable. Run `pi update git:github.com/cv/pit`, then `/reload`. If a pinned tag is unavailable, verify that the tag exists in [GitHub Releases](https://github.com/cv/pit/releases).

### An edit reports a revision or anchor mismatch

Submit a new read or search call. Use only the new revision and anchors in the next edit. Do not reuse anchors from an earlier read.

### A result is truncated

Reduce the requested line count or result limit. Narrow the file path, glob, or search query. Return a summary instead of a complete data set.

### A UI method fails

Run Pi in a mode that provides a UI. Do not use a UI capability in a non-UI mode.

### A saved function is unavailable

Run `/functions list` and confirm that the function exists on the active session branch. Call `context.get()` to inspect the active function names.

## Support

Use [GitHub Issues](https://github.com/cv/pit/issues) for reproducible bugs and focused feature requests. Pit follows a best-effort support model for the tested Pi and Node.js versions documented above. Other Pi releases, operating systems, shells, and terminal environments may work but are not guaranteed.

Do not report suspected vulnerabilities in public issues. Follow [SECURITY.md](SECURITY.md) instead. Contributions are welcome under [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

See [`docs/architecture.md`](docs/architecture.md) for the runtime request flow, trust boundaries, saved-function model, capability composition, source boundaries, and implementation invariants.

Use the local source:

```sh
npm install
pi --no-extensions -e ./src/index.ts
```

Run the project checks:

```sh
npm run check
npm test
npm run coverage
npm run package:check
```

Regenerate the capability contract after a registry change:

```sh
npm run capabilities:generate
```

Apply safe lint fixes and format the repository with Oxlint and Oxfmt:

```sh
npm run lint:fix
npm run format
```

`npm run check` verifies the generated capability contract and structural boundaries, runs TypeScript, runs Oxlint with warnings denied, and checks Oxfmt output. The structure check limits root-level source files and rejects internal import cycles. The custom quality audit retains Pit's file, function, and complexity limits.

Pull requests and pushes to `main` run package verification, static checks, dependency auditing, and coverage on the supported Node.js matrix. Public branch protection requires those checks before merge. See [the release guide](docs/releasing.md) for tagged GitHub releases.

## License

[MIT](LICENSE)
