# pit

A Pi extension that replaces the normal coding tools with one tool: `typescript`.

Pit lets the model combine workspace operations, common Git operations, shell commands, HTTP requests, UI prompts, and ordinary computation in one contextually type-checked call. This reduces tool round trips and keeps intermediate data out of the model context.

Each call runs in a fresh, permission-restricted process. Successful workflows can become typed, branch-local functions that the model can reuse and compose.

## Terminology

- **Operator:** The person who installs Pit, runs Pi, and reviews operations.
- **Model:** The language model that generates `typescript` tool calls.
- **Submitted code:** The TypeScript that runs in the restricted process.
- **Contributor:** A person who changes or tests Pit.

## Key features

- **Batch work:** The model combines multiple operations in one tool call.
- **Check code before execution:** Pit validates TypeScript against the active capability contract.
- **Edit with revisions:** Pit rejects stale revisions, stale anchors, and conflicting changes.
- **Reuse workflows:** Pit saves typed functions that the model can reuse on the active session branch.
- **Restrict direct access:** Pit runs each call in a fresh Node process with limited permissions.
- **Keep results compact:** Pit renders structured results in the TUI and returns bounded data to the model.

## Example

The model submits a TypeScript expression. A one-shot function destructures the host capabilities that it uses:

```ts
async ({ workspace, git }) => {
  const [manifests, status] = await Promise.all([
    workspace.glob("**/package.json", {
      ignore: ["**/node_modules/**"],
    }),
    git.status(["--short"]),
  ]);

  return { manifests, status };
}
```

The resolved value becomes the tool result. The model can batch operations and process their results without a separate tool call for each step.

## Install

Pit requires Node 22.19 or newer. The sandbox uses the Node permission model and the current Pi extension API.

Pit is a private Git-based Pi package. The operator must have access to the repository. The operator must configure GitHub SSH credentials before installation.

The operator runs this command to install the pinned release globally:

```sh
pi install git:git@github.com:cv/pit.git@v0.7.0
```

The operator runs this command to install the pinned release for the current project:

```sh
pi install -l git:git@github.com:cv/pit.git@v0.7.0
```

The operator runs this command to use the pinned release one time without a settings change:

```sh
pi -e git:git@github.com:cv/pit.git@v0.7.0
```

A contributor runs these commands to use the local source:

```sh
npm install
pi -e ./src/index.ts
```

Pit replaces the active coding tool set with `typescript` when the session starts. The operator must review the source before installation. Pi extensions run with the permissions of the host process.

## How Pit works

For each call, Pit does these steps:

1. It contextually type-checks the submitted TypeScript.
2. It compiles the TypeScript to JavaScript.
3. It starts a fresh Node process with restricted permissions.
4. It injects local proxies for the requested host capabilities.
5. It sends capability calls to the trusted extension process through bounded RPC.
6. It returns the resolved JSON-compatible value to the model.

The child process cannot directly read workspace files, access the network, or start subprocesses. It must use an injected capability for these effects.

### TUI display

The Pi TUI shows a compact description while the model generates a call. An animated spinner marks active generation and execution, and the row also shows live durations.

Collapsed rows hide source and result bodies. The operator presses `Ctrl+O` to expand a row. The expanded row shows the submitted source and the retained result. Pit does not show injected saved-function source in tool output.

Common capability results use compact structured renderers. These results include Git and shell commands, workspace reads, searches, edits, lists, globs, HTTP responses, stats, and batches. Recognized values inside compound objects appear as named sections. Unknown values use syntax-highlighted JSON.

Direct `git.*` results use method-specific summaries and formatting. Status codes, diffs, commit history, tags, commit output, and push diagnostics receive Git-aware styling while preserving the original serialized result.

Each invocation retains up to 128 runtime capability traces for TUI attribution. A trace records capability and method names, source order, timing, duration, and outcome. Argument metadata contains only bounded type-and-size summaries, never argument values. Additional calls set a truncation flag instead of growing session details without bound. Runtime traces let saved-function results use the same capability-specific renderers as direct calls; ambiguous multi-call results retain generic fallback rendering.

Long-running shell calls show a sanitized and bounded tail of standard output and standard error in partial tool updates. These updates do not become part of the final model context.

Display formatting affects only the TUI. It does not change the serialized tool result.

## Function contract

Submitted code must be a TypeScript expression. Submitted code cannot contain imports.

For one-time work, the model submits an anonymous function:

```ts
async ({ workspace, shell }) => {
  return jsonSerializableValue;
}
```

Pit contextually types destructured capabilities. Capability annotations are not required. The generated contract is in [`src/capability-contract.d.ts`](src/capability-contract.d.ts). The method declarations, dispatch metadata, arity limits, and model-facing summaries are in [`src/capability-registry.ts`](src/capability-registry.ts).

Validation detects unknown capabilities, unknown methods, invalid arguments, missing awaits, and incompatible result values. Diagnostics include source locations.

For large patches, generated file contents, commit messages, and other quote-heavy data, the model supplies data in top-level `params`. The second function parameter must have a type annotation:

```json
{
  "code": "async ({ workspace }, input: { file: string; contents: string }) => workspace.edit(input.file, { revision: null, changes: [{ kind: 'replaceFile', content: input.contents }] })",
  "params": {
    "file": "src/generated.ts",
    "contents": "export const generated = true;\n"
  }
}
```

Top-level `params` are valid with a one-shot function. They are also valid for the first execution of a named function.

Capability calls are asynchronous. A call starts when the function invokes the capability method. Pit waits for outstanding calls before it accepts a successful result.

Submitted code uses `Promise.all` when all operations must succeed. It uses `Promise.allSettled` or a local `catch` for an optional operation. It sequences dependent operations. It does not run conflicting mutations in parallel.

This example preserves the successful result when an optional file does not exist:

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

## Capabilities

### `workspace`

- `read(file, { format?: "hashed" | "raw", offset?, limit? })` reads a bounded selection. Hashed format is the default.
- `edit(file, { revision, changes })` applies revision-checked anchored or file-level changes.
- `batch(operations, { failure?: "fail-fast" | "settled" })` runs a homogeneous read batch or edit batch.
- `search(query, options?)` returns bounded matches with revisions and line anchors.
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
Arguments are passed directly after the fixed subcommand without shell interpolation. Use `shell.execFile("git", ...)` for less common Git subcommands.

### `shell`

- `exec(command, options?)` runs a command through the shell.
- `execFile(program, args, options?)` runs a program with an argument array.

Git and shell process methods support `cwd`, `timeoutMs`, `raise`, `maxBytes`, `maxLines`, and `truncate`. A nonzero exit is result data by default. A value of `true` for `raise` makes a nonzero exit stop the function.

### `http`

- `request(url, { method?, headers?, body?, maxBytes? })` sends an HTTP request and returns a bounded body.

### `ui`

- `confirm(title, message)` asks for confirmation.
- `input(title, placeholder?)` asks for text.
- `select(title, options)` asks for one selection.
- `notify(message, level?)` shows a notification.

UI methods require a mode that provides a UI.

### `context`

- `get()` returns the working directory, mode, model, thinking level, session file, and saved-function names.

Paths are relative to the Pi working directory. Absolute paths are also valid. Workspace mutation results use slash-normalized paths relative to the working directory. A path outside the working directory contains `../` segments in the result.

Output is bounded. Read metadata uses sparse defaults. If `offset` is absent, its value is 1. If `totalLines` is absent, its value is equal to `lines`. If `hasMore` or `truncated` is absent, its value is false.

## Revision-safe edits

Hashed reads show each selected line as `line:hash|content`. They also return a revision for the complete UTF-8 file:

```text
41:k3F9q|function example() {
42:7Qa2m|  return true;
43:p91Xs|}
```

An edit requires the current file revision and current line anchors. `workspace.read` and `workspace.search` return this data:

```ts
await workspace.edit("src/example.ts", {
  revision: "J8xM2pQa7vL4",
  changes: [
    { kind: "replace", start: "42:7Qa2m", content: "  return false;" },
    { kind: "insertAfter", anchor: "43:p91Xs", content: "export { example };" },
  ],
});
```

`replace` and `delete` apply to anchored line ranges. An absent end anchor selects one line. `insertBefore` and `insertAfter` add content at an anchor. `replaceFile` rewrites a file. `deleteFile` deletes a file.

File creation requires `revision: null` and one `replaceFile` change. A rewrite or deletion of an existing file requires its current revision.

Pit validates all anchors against the supplied revision. It rejects overlapping changes. It applies compatible changes from the bottom of the file to the top. It converts inserted `\n` characters to the dominant line ending of the file. It preserves untouched bytes.

A successful edit invalidates all earlier revisions and anchors for that file. A later edit requires a new read or search.

Search matches include anchors and file revisions. An edit can use this data directly.

A read batch can use `fail-fast` or `settled` failure handling. An edit batch must target unique files. Pit validates every edit before the first write. If a later write fails, Pit makes a best-effort attempt to restore files that it already changed. A multi-file edit batch is not an atomic filesystem transaction.

## Saved functions

For work that can recur, the model submits a named top-level function:

```ts
async function runTests({ shell }, input: { coverage?: boolean } = {}) {
  const args = input.coverage ? ["run", "coverage"] : ["test"];
  return shell.execFile("npm", args, { raise: true });
}
```

Pit validates and runs the function. Pit saves it only after execution succeeds.

A value of `true` for `saveOnly` validates and saves a function without execution. A save-only definition cannot contain top-level `params`:

```json
{
  "code": "async function runChecks({ shell }) { return shell.execFile('npm', ['test'], { raise: true }); }",
  "saveOnly": true
}
```

When the first execution needs input, the model supplies top-level `params`:

```json
{
  "code": "async function inspect({ workspace }, input: { file: string }) { return workspace.read(input.file, { format: 'raw' }); }",
  "params": { "file": "README.md" }
}
```

A later tool call invokes a saved function as an ordinary TypeScript expression:

```ts
runTests()
runTests({ coverage: true })
```

Saved functions can call other saved functions. Pit injects only referenced functions and their transitive dependencies. It preserves input and return types across calls. It limits nested saved-function calls to a depth of 32.

Saved functions survive session reloads and follow the active session branch. A replacement must preserve the validity of dependent functions. Each branch can contain 64 functions. One function can contain 100 KB of source. The combined source limit is 1 MB.

The operator runs `/functions` to open the interactive function manager in the TUI. The operator can also run these direct commands:

```text
/functions list
/functions show runTests
/functions delete runTests
```

Deletion creates a branch-local tombstone. If another saved function depends on the selected function, Pit asks for confirmation before it deletes both functions.

## Security model

The submitted TypeScript runs in a new Node process with these restrictions:

- The process can read only the fixed sandbox runner directly.
- The process has no direct network access.
- The process cannot start subprocesses or workers.
- The process cannot load native addons.
- The process cannot use the inspector or WASI.
- The process receives a minimal environment without host credentials.
- The process has a memory limit and a wall-clock timeout.

Filesystem, command, HTTP, and UI effects are available only through RPC capabilities. Calls and protocol frames have size and concurrency limits. Timeout and cancellation signals propagate to cooperative host operations.

The sandbox restricts direct access. It does not make host capabilities harmless. The `git` and `shell` capabilities run commands with the permissions of the Pi process. Git hooks and Git network operations can have external effects. Workspace methods accept absolute paths and paths outside the working directory. The `http` capability can request any destination that the host can reach.

Capability destructuring makes intent visible. It is not an operator approval boundary. The operator must review generated calls before execution when an operation can affect sensitive data or systems.

This isolation is stronger than `node:vm`, which is not a security boundary. It does not replace a container, virtual machine, or operating-system sandbox. Operators of hostile models or multi-tenant workloads must use an additional operating-system boundary.

## Limitations

- Pit depends on the Node permission model and requires Node 22.19 or newer.
- Saved functions belong to one session branch. Pit does not provide a shared project function library.
- Workspace paths are not restricted to the current project.
- Shell commands are not restricted by an allowlist.
- The `git` capability allowlists subcommands, but it does not restrict their arguments, hooks, remotes, or network destinations.
- HTTP requests are not restricted by a host allowlist.
- Multi-file edit rollback is best effort and is not atomic.
- Returned content, shell output, HTTP bodies, glob results, and search results have limits.
- Workspace search skips binary files and files larger than 1 MB. It searches at most 2,000 files per call.
- The sandbox is an application boundary, not a container or virtual machine.

## Troubleshooting

### Pi reports an unsupported Node version

The operator runs `node --version`. The operator installs Node 22.19 or newer. The operator starts Pi again with the new Node version.

### Git cannot install the package

The operator runs `ssh -T git@github.com`. The operator confirms that GitHub accepts the SSH key. The operator confirms that the account can access `cv/pit`.

### An edit reports a revision or anchor mismatch

The model submits a new read or search call. The next edit uses only the new revision and anchors. It does not reuse anchors from an earlier read.

### A result is truncated

The model reduces the requested line count or result limit. It narrows the file path, glob, or search query. It returns a summary instead of a complete data set.

### A UI method fails

The operator runs Pi in a mode that provides a UI. Submitted code does not use a UI capability in a non-UI mode.

### A saved function is unavailable

The operator runs `/functions list` and confirms that the function exists on the active session branch. The model calls `context.get()` when it must inspect the active function names.

## Development

This section is for contributors.

Install dependencies:

```sh
npm install
```

Run all static checks:

```sh
npm run check
```

Run the tests:

```sh
npm test
```

Run the coverage gate:

```sh
npm run coverage
```

Regenerate the capability contract after a registry change:

```sh
npm run capabilities:generate
```

Apply Biome fixes:

```sh
npm run biome:fix
```

Verify the Git-installable package layout:

```sh
npm run package:check
```

`npm run check` verifies the generated capability contract. It then runs TypeScript and Biome. Biome uses the `all` lint preset and treats warnings as errors.

Pull requests and pushes to `main` run package verification, static checks, tests, and the coverage gate in GitHub Actions. A repository maintainer must configure branch protection to require the `test` check before merge.

## License

[MIT](LICENSE)
