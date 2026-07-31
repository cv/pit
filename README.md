# pit

A Pi extension that replaces the normal coding tools with one tool: `typescript`.

Pit lets the model combine workspace operations, shell commands, HTTP requests, UI prompts, and ordinary computation in one contextually type-checked call. This reduces tool round trips and keeps intermediate data out of the model context.

Each call runs in a fresh, permission-restricted process. Successful workflows can become typed, branch-local functions that the model can reuse and compose.

## Key features

- **Batch work:** Combine multiple operations in one tool call.
- **Check code before execution:** Validate TypeScript against the active capability contract.
- **Edit with revisions:** Reject stale anchors and conflicting changes.
- **Reuse workflows:** Save typed functions on the active session branch.
- **Restrict direct access:** Run each call in a fresh Node process with limited permissions.
- **Keep results compact:** Render structured results in the TUI and return bounded data to the model.

## Example

The model submits a TypeScript expression. A one-shot function destructures the host capabilities that it uses:

```ts
async ({ workspace, shell }) => {
  const [manifests, status] = await Promise.all([
    workspace.glob("**/package.json", {
      ignore: ["**/node_modules/**"],
    }),
    shell.execFile("git", ["status", "--short"]),
  ]);

  return { manifests, status };
}
```

The resolved value becomes the tool result. The model can batch operations and process their results without a separate tool call for each step.

## Install

Pit requires Node 22.19 or newer. The sandbox uses the Node permission model and the current Pi extension API.

Pit is a private Git-based Pi package. Make sure that you have repository access. Configure GitHub SSH credentials before you install Pit.

Install the pinned release globally:

```sh
pi install git:git@github.com:cv/pit.git@v0.5.2
```

Install the pinned release for the current project:

```sh
pi install -l git:git@github.com:cv/pit.git@v0.5.2
```

Run the pinned release one time without a settings change:

```sh
pi -e git:git@github.com:cv/pit.git@v0.5.2
```

Use the local source during development:

```sh
npm install
pi -e ./src/index.ts
```

Pit replaces the active coding tool set with `typescript` when the session starts. Review the source before installation. Pi extensions run with the permissions of the host process.

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

The Pi TUI shows a compact description while the model generates a call. It also shows live generation and execution durations.

Collapsed rows hide source and result bodies. Press `Ctrl+O` to expand a row. The expanded row shows the submitted source and the retained result. Pit does not show injected saved-function source in tool output.

Common capability results use compact structured renderers. These results include shell commands, workspace reads, searches, edits, lists, globs, HTTP responses, stats, and batches. Recognized values inside compound objects appear as named sections. Unknown values use syntax-highlighted JSON.

Long-running shell calls show a sanitized and bounded tail of standard output and standard error in partial tool updates. These updates do not become part of the final model context.

Display formatting affects only the TUI. It does not change the serialized tool result.

## Function contract

The `code` argument must be a TypeScript expression. Do not use imports.

Use an anonymous function for one-time work:

```ts
async ({ workspace, shell }) => {
  return jsonSerializableValue;
}
```

Pit contextually types destructured capabilities. You do not have to add source annotations for them. The generated contract is in [`src/capability-contract.d.ts`](src/capability-contract.d.ts). The method declarations, dispatch metadata, arity limits, and model-facing summaries are in [`src/capability-registry.ts`](src/capability-registry.ts).

Validation detects unknown capabilities, unknown methods, invalid arguments, missing awaits, and incompatible result values. Diagnostics include source locations.

Use top-level `params` for large patches, generated file contents, commit messages, and other quote-heavy data. Annotate the second function parameter:

```json
{
  "code": "async ({ workspace }, input: { file: string; contents: string }) => workspace.edit(input.file, { revision: null, changes: [{ kind: 'replaceFile', content: input.contents }] })",
  "params": {
    "file": "src/generated.ts",
    "contents": "export const generated = true;\n"
  }
}
```

You can use `params` with a one-shot function. You can also use `params` for the first execution of a named function.

Capability calls are asynchronous. A call starts when the function invokes the capability method. Pit waits for outstanding calls before it accepts a successful result.

Use `Promise.all` when all operations must succeed. Use `Promise.allSettled` or a local `catch` for an optional operation. Sequence dependent operations. Do not run conflicting mutations in parallel.

For example, preserve the successful result when an optional file does not exist:

```ts
async ({ workspace, shell }) => {
  const [config, status] = await Promise.allSettled([
    workspace.read("optional.config.json", { format: "raw" }),
    shell.execFile("git", ["status", "--short"]),
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

### `shell`

- `exec(command, options?)` runs a command through the shell.
- `execFile(program, args, options?)` runs a program with an argument array.

Both methods support `cwd`, `timeoutMs`, `raise`, `maxBytes`, `maxLines`, and `truncate`. A nonzero exit is result data by default. Set `raise: true` to make a nonzero exit stop the function.

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

Read the file before you edit it. Use the returned revision and anchors in the edit:

```ts
await workspace.edit("src/example.ts", {
  revision: "J8xM2pQa7vL4",
  changes: [
    { kind: "replace", start: "42:7Qa2m", content: "  return false;" },
    { kind: "insertAfter", anchor: "43:p91Xs", content: "export { example };" },
  ],
});
```

Use `replace` or `delete` for an anchored line range. Omit the end anchor to change one line. Use `insertBefore` or `insertAfter` to add content at an anchor. Use `replaceFile` to rewrite a file. Use `deleteFile` to delete a file.

To create a file, set `revision` to `null`. Supply one `replaceFile` change. To rewrite or delete an existing file, supply its current revision.

Pit validates all anchors against the supplied revision. It rejects overlapping changes. It applies compatible changes from the bottom of the file to the top. It converts inserted `\n` characters to the dominant line ending of the file. It preserves untouched bytes.

Discard the old revision and anchors after a successful edit. Read the file again before a later edit.

Search matches include anchors and file revisions. You can use them directly in an edit.

A read batch can use `fail-fast` or `settled` failure handling. An edit batch must target unique files. Pit validates every edit before the first write. If a later write fails, Pit makes a best-effort attempt to restore files that it already changed. A multi-file edit batch is not an atomic filesystem transaction.

## Saved functions

Use a named top-level function for work that can recur:

```ts
async function runTests({ shell }, input: { coverage?: boolean } = {}) {
  const args = input.coverage ? ["run", "coverage"] : ["test"];
  return shell.execFile("npm", args, { raise: true });
}
```

Pit validates and runs the function. Pit saves it only after execution succeeds.

Set `saveOnly: true` to validate and save a function without execution. Do not supply top-level `params` with `saveOnly`:

```json
{
  "code": "async function runChecks({ shell }) { return shell.execFile('npm', ['test'], { raise: true }); }",
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

Invoke a saved function as an ordinary TypeScript expression:

```ts
runTests()
runTests({ coverage: true })
```

Saved functions can call other saved functions. Pit injects only referenced functions and their transitive dependencies. It preserves input and return types across calls. It limits nested saved-function calls to a depth of 32.

Saved functions survive session reloads and follow the active session branch. A replacement must preserve the validity of dependent functions. Each branch can contain 64 functions. One function can contain 100 KB of source. The combined source limit is 1 MB.

Use `/functions` to open the interactive function manager in the TUI. Use these commands for a direct operation:

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

The sandbox restricts direct access. It does not make host capabilities harmless. The `shell` capability runs commands with the permissions of the Pi process. Workspace methods accept absolute paths and paths outside the working directory. The `http` capability can request any destination that the host can reach.

Capability destructuring makes intent visible. It is not a user approval boundary. Review generated calls before you allow them to run when the operation can affect sensitive data or systems.

This isolation is stronger than `node:vm`, which is not a security boundary. It does not replace a container, virtual machine, or operating-system sandbox. Use an additional operating-system boundary for hostile models or multi-tenant workloads.

## Limitations

- Pit depends on the Node permission model and requires Node 22.19 or newer.
- Saved functions belong to one session branch. Pit does not provide a shared project function library.
- Workspace paths are not restricted to the current project.
- Shell commands are not restricted by an allowlist.
- HTTP requests are not restricted by a host allowlist.
- Multi-file edit rollback is best effort and is not atomic.
- Returned content, shell output, HTTP bodies, glob results, and search results have limits.
- Workspace search skips binary files and files larger than 1 MB. It searches at most 2,000 files per call.
- The sandbox is an application boundary, not a container or virtual machine.

## Troubleshooting

### Pi reports an unsupported Node version

Run `node --version`. Install Node 22.19 or newer. Start Pi again with the new Node version.

### Git cannot install the package

Run `ssh -T git@github.com`. Confirm that GitHub accepts your SSH key. Confirm that your account can access `cv/pit`.

### An edit reports a revision or anchor mismatch

Read the file again. Use only the new revision and anchors. Do not reuse anchors from an earlier read.

### A result is truncated

Reduce the requested line count or result limit. Narrow the file path, glob, or search query. Return a summary instead of a complete data set.

### A UI method fails

Run the call in a Pi mode that provides a UI. Do not use a UI capability in a non-UI mode.

### A saved function is unavailable

Run `/functions list`. Confirm that the function exists on the active session branch. Use `context.get()` when the model must inspect the active function names.

## Development

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

Pull requests and pushes to `main` run package verification, static checks, tests, and the coverage gate in GitHub Actions. Configure branch protection to require the `test` check before merge.

## License

[MIT](LICENSE)
