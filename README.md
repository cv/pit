# pit

**Give Pi one typed tool instead of a toolbox.**

Pit replaces Pi's normal coding tools with one `typescript` tool. One call can inspect a repository, edit files, run checks, use Git and GitHub, make HTTP requests, and request interactive input.

This design gives Pit four main benefits:

- **Fewer round trips:** One call can combine related operations and ordinary computation.
- **Less context noise:** Intermediate data stays in the restricted process. Only the final result enters the model context.
- **Earlier feedback:** Pit checks each TypeScript call against the active capability contract before execution.
- **Reusable workflows:** A successful workflow can become a typed, branch-local function for later calls and composition.

Each call runs in a fresh, permission-restricted process. Capabilities make effects explicit, and bounded results keep the model context and TUI compact.

## See one call

One call can inspect files and Git state in parallel, then return only the useful summary:

```ts
async ({ workspace, git }) => {
  const [manifest, status] = await Promise.all([
    workspace.read("package.json", { format: "raw" }),
    git.status(["--short"]),
  ]);

  const pkg = JSON.parse(manifest.content);
  return {
    package: pkg.name,
    scripts: Object.keys(pkg.scripts ?? {}),
    status: status.stdout,
  };
}
```

The resolved value becomes the tool result. Pi does not need a separate tool call for each read, command, or intermediate calculation.

## Install Pit

Pit requires Node 22.19 or newer and Pi 0.80.10 or newer. It uses the Node permission model and Pi's structured system-prompt API to preserve discovered skills while replacing the active tools.

Pit is a private Git-based Pi package. You need repository access and configured GitHub SSH credentials.

Install the pinned release globally:

```sh
pi install git:git@github.com:cv/pit.git@v0.13.0
```

Install the pinned release for the current project:

```sh
pi install -l git:git@github.com:cv/pit.git@v0.13.0
```

Use the pinned release one time without a settings change:

```sh
pi -e git:git@github.com:cv/pit.git@v0.13.0
```

Pit replaces the active coding tool set with `typescript` when the session starts.

> [!IMPORTANT]
> Review the source before installation. Pi extensions run with the permissions of the host process. Pit restricts submitted code, but its host capabilities can still change files, run commands, and access the network.

## Know what Pit can do

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
async ({ workspace, shell }) => {
  return jsonSerializableValue;
}
```

Pit contextually types destructured capabilities. Capability annotations are not necessary. Validation detects unknown capabilities, unknown methods, invalid arguments, missing awaits, and incompatible result values. Diagnostics include source locations.

### Pass large data in `params`

Use top-level `params` for large patches, generated file contents, commit messages, and other quote-heavy data. The second function parameter must have a type annotation:

```json
{
  "code": "async ({ workspace }, input: { file: string; contents: string }) => workspace.edit(input.file, { revision: null, changes: [{ kind: 'replaceFile', content: input.contents }] })",
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
async ({ workspace, git }) => {
  const [config, status] = await Promise.allSettled([
    workspace.read("optional.config.json", { format: "raw" }),
    git.status(["--short"]),
  ]);
  return { config, status };
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
await workspace.edit("src/example.ts", {
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
async function runTests({ npm }, input: { coverage?: boolean } = {}) {
  return npm.test({ coverage: input.coverage, raise: true });
}
```

Pit validates and runs the function. It saves the function only after execution succeeds.

Set `saveOnly` to `true` to validate and save a function without execution. A save-only definition cannot use top-level `params`:

```json
{
  "code": "async function runChecks({ npm }) { return npm.test({ raise: true }); }",
  "saveOnly": true
}
```

Supply top-level `params` when the first execution needs input:

```json
{
  "code": "async function inspect({ workspace }, input: { file: string }) { return workspace.read(input.file, { format: 'raw' }); }",
  "params": { "file": "README.md" }
}
```

Call a saved function as an ordinary TypeScript expression:

```ts
runTests()
runTests({ coverage: true })
```

Unmarked named functions become session functions. They survive reloads and follow the active session branch. A replacement is rejected if it invalidates a dependent function.

Saved functions can call other saved functions. Pit injects only referenced functions and their transitive dependencies into each restricted process. Types remain available across calls. Nested calls have a maximum depth of 32.

The effective registry contains global, project, and session functions. Resolution precedence is session, then project, then global. The registry has these limits:

- 64 functions.
- 100 KB for one function.
- 1 MB of combined saved source.

Successful tool results include a compact, compaction-safe catalog of active session-function signatures. Effective global and project functions are documented in the system prompt instead of being repeated in every result. Catalogs contain only complete signatures and report omitted entries when they reach the output budget. `context.get().savedFunctions` also lists all effective names.
Pit tracks only in-memory invocation counts by function name; it does not retain arguments, source, or results as usage telemetry. After five invocations in one loaded branch lifecycle, a non-temporary session function receives one bounded suggestion to use `functions.promote(name, summary)`. Global functions, project functions, session overrides, and names that look temporary are excluded. Reload and session-tree navigation reset counts and suggestion state.

### Reuse user-global functions

Global functions are disabled by default. Enable them in the Pi agent directory, which defaults to `~/.pi/agent/pit.json` and respects `PI_CODING_AGENT_DIR`:

```json
{
  "globalFunctions": {
    "enabled": true
  }
}
```

Pit stores readable global source files in `~/.pi/agent/pit/functions/` and requires an `@pit global` JSDoc marker. Global definitions are available across projects after `/reload`. A trusted project can opt out with `{ "globalFunctions": { "enabled": false } }` in `.pi/pit.json`.

Use `functions.promote(name, summary, { to: "global" })` or **Save globally** in `/functions`. Global promotion and removal require interactive confirmation. Promotion is blocked while the session function depends on project or session functions; promote stable dependencies first. Global functions resolve only global dependencies. Project functions resolve project definitions with global fallback. Session functions resolve session, project, then global definitions.

### Share trusted project functions

Project functions are disabled by default. Enable them only for a trusted project in `.pi/pit.json`:

```json
{
  "projectFunctions": {
    "enabled": true
  }
}
```

Add a descriptive JSDoc comment with `@pit project` to persist a named function across sessions:

```ts
/**
 * Runs repository tests.
 *
 * @pit project
 * @param input.coverage - Enable coverage.
 */
async function runTests({ npm }, input: { coverage?: boolean } = {}) {
  return npm.test({ coverage: input.coverage, raise: true });
}
```

Project functions use the same execution rules as session functions. Pit commits a function after successful execution, or after static validation when `saveOnly` is `true`.

Pit stores project functions as readable TypeScript files in `.pi/pit/functions/`. It loads them at session start and shows their derived signatures in the system prompt. An unmarked definition with the same name creates a session override. A marked definition updates the project version and clears that override.

Pit loads project source only after explicit opt-in and Pi's project-trust check. The function still runs in the same restricted process as a session function.

Use `functions.list()`, `functions.get(name)`, and `functions.remove(name)` to manage project definitions. Use `functions.listGlobal()`, `functions.getGlobal(name)`, and confirmed `functions.removeGlobal(name)` for user-global definitions. Use `functions.listAll()` and `functions.getSaved(name, scope?)` to inspect effective or explicitly scoped functions, including dependencies, dependents, and override state. Use `functions.planRemoval(name, scope?)` to inspect an exact removal closure without mutation. Session removal rejects dependent cascades unless `functions.removeSession(name, { cascade: true })` explicitly opts in. Use `functions.promote(name, summary)` to save a session function to the project or pass `{ to: "global" }` for confirmed global persistence. Persistent removal remains blocked when saved functions depend on the target. Disabling global or project functions does not delete existing source files.

### Manage saved functions

Run `/functions` without arguments to open the interactive TUI manager. The manager lists session and project functions with their scope. These direct commands are also available:

```text
/functions list
/functions show runTests
/functions delete runTests
```

Select a session function to inspect it, save it to the project, or delete it. **Save to project** asks for a short summary, adds the `@pit project` marker, writes the project function, and removes the session definition. This action requires an enabled, trusted project.

Select a project function to inspect it or remove it from the project. Project removal fails when a project or session function depends on the target.

`/functions delete` creates a branch-local tombstone. After confirmation, it also deletes session dependents.

### Reflect on reusable work

Pit packages a `/pit-reflect [focus]` prompt template. It reviews work completed in the current session, compares recurring workflows with the effective saved-function registry, and makes only high-confidence additions or improvements. It prefers extending or composing existing functions, keeps unproven helpers session-scoped, and reports when no new function is justified.

## Understand execution

Pit completes these steps for each call:

1. It contextually type-checks the submitted TypeScript.
2. It compiles the TypeScript to JavaScript.
3. It starts a fresh Node process with restricted permissions.
4. It injects local proxies for the requested host capabilities.
5. It sends capability calls to the trusted extension process through bounded RPC.
6. It returns the resolved JSON-compatible value to the model.

The child process cannot directly read workspace files, access the network, or start subprocesses. It must use an injected capability for these effects.

Failed TypeScript calls still use Pi's required thrown-error path and remain `isError: true`. Pit enriches the final result through `tool_result` middleware with a bounded root error, saved-function path, function activity, and redacted capability traces. Expanded TUI failures show the function path and execution dashboard. Non-function failures keep an empty path and concise error text.

The generated capability contract is in [`src/capability-contract.d.ts`](src/capability-contract.d.ts). Authoritative method declarations, arity limits, model summaries, TUI descriptions, and result-renderer keys are in [`src/capability-registry.ts`](src/capability-registry.ts). Public host dispatch is exhaustive over the registered capability names. A new capability requires a host implementation before TypeScript checks pass.

## Read results in the TUI

The Pi TUI shows a compact call description during generation and execution. A spinner identifies active work, and the row shows live durations.

Press `Ctrl+O` to expand a tool row. The expanded row shows submitted source and the retained result. Pit does not show injected saved-function source in tool output.

Pit uses compact structured renderers for common capability results. Compound objects can show recognized values as named sections. Unknown values use syntax-highlighted JSON. Git results use Git-aware summaries and styling while they preserve the serialized result.

Expanded running rows show a live capability dashboard in source order. Each entry shows the capability, method, state, and duration. Project and session functions include their scope. Long-running shell calls show a sanitized, bounded tail of standard output and standard error. Partial updates do not enter the final model context.

Each invocation retains at most 128 runtime capability traces for TUI attribution. A trace records names, source order, timing, duration, and outcome. Argument metadata contains bounded type-and-size summaries, not argument values. Additional calls set a truncation flag. Traces let saved-function results use the same renderers as direct calls. Ambiguous multi-call results use generic rendering.

Display formatting changes only the TUI. It does not change the serialized tool result.

## Security model

Submitted TypeScript runs in a new Node process with these restrictions:

- The process can read only the fixed sandbox runner directly.
- The process has no direct network access.
- The process cannot start subprocesses or workers.
- The process cannot load native addons.
- The process cannot use the inspector or WASI.
- The process receives a minimal environment without host credentials.
- The process has a memory limit and a wall-clock timeout.

Filesystem, command, HTTP, and UI effects are available only through RPC capabilities. Calls and protocol frames have size and concurrency limits. Timeout and cancellation signals propagate to cooperative host operations.

The sandbox restricts direct access. It does not make host capabilities harmless. The `git` and `shell` capabilities run commands with the permissions of the Pi process. Git hooks and Git network operations can have external effects. Workspace methods accept absolute paths and paths outside the working directory. The `http` capability can request any destination that the host can reach.

Capability destructuring makes intent visible. It is not an approval boundary. Review generated calls before execution when an operation can affect sensitive data or systems.

This isolation is stronger than `node:vm`, which is not a security boundary. It does not replace a container, virtual machine, or operating-system sandbox. If you use a hostile model or a multi-tenant workload, use an additional operating-system boundary.

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

- `get()` returns the working directory, mode, model, thinking level, session file, effective/global/project/session function names, and global/project enablement.

### `session`

- `info()` returns the session ID, file, display name, entry counts, leaf ID, and context usage.
- `getName()` returns the session display name.
- `setName(name)` sets the session display name.
- `compact(instructions?)` awaits manual compaction and returns bounded cut-point and token metadata without returning the generated summary.

### `commands`

- `list()` returns bounded extension, prompt-template, and skill commands with canonical source information. Built-in interactive commands are not included.

### `models`

- `current()` returns bounded metadata for the active model.
- `list(options?)` returns bounded model metadata; available models are the default.
- `set(provider, id)` selects an explicit configured model and fails when credentials are unavailable.

### `runtime`

- `status()` reports mode, idle state, and whether messages are queued.

### `functions`

- `list()` lists documented project functions.
- `get(name)` returns project function metadata and source.
- `remove(name)` removes a project function when no function depends on it.
- `listGlobal()` lists user-global functions.
- `getGlobal(name)` returns global function metadata and source.
- `removeGlobal(name)` removes a global function after interactive confirmation when no function depends on it.
- `listAll()` lists effective functions with scope, dependencies, dependents, and override state.
- `getSaved(name, scope?)` returns effective or explicitly scoped source and dependency metadata.
- `planRemoval(name, scope?)` returns the exact removal closure and blockers without mutation.
- `promote(name, summary, options?)` saves a session function to the trusted project by default or globally with `{ to: "global" }` after confirmation.
- `removeSession(name, options?)` removes a branch-local function; dependent cascades require `{ cascade: true }`.

### Common behavior

Paths are relative to the Pi working directory. Absolute paths are also valid. Workspace mutation results use slash-normalized paths relative to the working directory. A path outside the working directory contains `../` segments in the result.

Output is bounded. Read metadata uses sparse defaults:

- If `offset` is absent, its value is 1.
- If `totalLines` is absent, its value is equal to `lines`.
- If `hasMore` or `truncated` is absent, its value is `false`.

## Limitations

- Pit depends on the Node permission model and requires Node 22.19 or newer.
- Session functions belong to one session branch.
- Global functions are user-local to one Pi agent directory; Pit does not synchronize them across machines.
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

### Git cannot install the package

Run `ssh -T git@github.com`. Confirm that GitHub accepts the SSH key. Confirm that the account can access `cv/pit`.

### An edit reports a revision or anchor mismatch

Submit a new read or search call. Use only the new revision and anchors in the next edit. Do not reuse anchors from an earlier read.

### A result is truncated

Reduce the requested line count or result limit. Narrow the file path, glob, or search query. Return a summary instead of a complete data set.

### A UI method fails

Run Pi in a mode that provides a UI. Do not use a UI capability in a non-UI mode.

### A saved function is unavailable

Run `/functions list` and confirm that the function exists on the active session branch. Call `context.get()` to inspect the active function names.

## Development

Use the local source:

```sh
npm install
pi -e ./src/index.ts
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

`npm run check` verifies the generated capability contract, runs TypeScript, runs Oxlint with warnings denied, and checks Oxfmt output. The custom quality audit retains Pit's file, function, and complexity limits.

Pull requests and pushes to `main` run package verification, static checks, tests, and the coverage gate in GitHub Actions. A repository maintainer must configure branch protection to require the `test` check before merge.

## License

[MIT](LICENSE)
