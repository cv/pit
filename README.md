# pit

A Pi extension that replaces the normal coding tools with one tool: `typescript`.

The model submits a TypeScript expression that runs in a fresh, permission-restricted process. One-shot functions explicitly destructure the host capabilities they need:

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

The expression's resolved value becomes the tool result. This lets the model batch several operations and perform ordinary computation without repeatedly crossing the model/tool boundary.

In the Pi TUI, each tool call shows the generated TypeScript as its arguments stream in. Common capability results—shell commands, workspace reads/searches/edits/lists/globs, HTTP responses, stats, and batches—use compact structured renderers. Recognized values nested in compound objects render as sections whose single-line headers combine the returned field name, result type, and summary, such as `sources (glob, 11 entries)`. Unknown values and fields retain syntax-highlighted JSON as the fallback. This display formatting is TUI-only and does not change the serialized tool result sent to the model. Long-running shell calls stream a sanitized, bounded tail of stdout and stderr into partial tool updates without adding those updates to the final model context. Collapsed views show the first 12 lines; press `Ctrl+O` to expand the row and inspect the complete source and result. Calls to saved functions also show the injected definitions and transitive saved dependencies in expanded mode, with per-function and total display limits.

## Install

Pit is distributed as a Git-based Pi package. The repository is private, so installation requires repository access and working GitHub SSH credentials.

Install the pinned release globally:

```sh
pi install git:git@github.com:cv/pit.git@v0.5.0
```

Install for the current project:

```sh
pi install -l git:git@github.com:cv/pit.git@v0.5.0
```

Try it for one run without changing settings:

```sh
pi -e git:git@github.com:cv/pit.git@v0.5.0
```

For local development:

```sh
npm install
pi -e ./src/index.ts
```

The extension intentionally replaces the active coding tool set with only `typescript` at session start. Review the source before installation: Pi extensions execute with the host process's permissions.

Requires Node 22.19 or newer because the sandbox uses Node's permission model and Pi's current extension API.

## Function contract

The `code` argument must be a TypeScript expression and cannot contain imports. Use an anonymous function for one-shot work:

```ts
async ({ workspace, shell }) => {
  // Use only the capabilities requested here.
  return jsonSerializableValue;
}
```

The expression is contextually type-checked before execution. No source annotations are required: destructured capabilities automatically receive the types in generated [`src/capability-contract.d.ts`](src/capability-contract.d.ts). The authoritative method declarations, dispatch metadata, arity constraints, and model-facing summaries live in [`src/capability-registry.ts`](src/capability-registry.ts). Validation catches unknown capabilities and methods, invalid arguments, missing awaits, and non-JSON-compatible results with source locations.

Use top-level `params` as the data channel for large patches, generated file contents, commit messages, and other quote-heavy payloads instead of embedding them in the TypeScript source:

```json
{
  "code": "async ({ workspace }, input: { file: string; contents: string }) => workspace.edit(input.file, { revision: null, changes: [{ kind: 'replaceFile', content: input.contents }] })",
  "params": {
    "file": "src/generated.ts",
    "contents": "export const generated = true;\n"
  }
}
```

This works for anonymous one-shot functions as well as the initial execution of named functions.

Each destructured capability is a local proxy. Calling one of its methods performs a size- and concurrency-bounded RPC to the trusted extension process. Calls begin immediately, and pit waits for outstanding calls before accepting a successful result. Timeout and cancellation signals propagate to cooperative host operations. Use `Promise.all` when any failed operation should fail the invocation; use `Promise.allSettled` or a local catch for optional exploratory probes. Sequence dependent calls and conflicting mutations. Unknown capabilities and methods also fail closed at runtime.

For example, preserve successful inspection results when an optional file may not exist:

```ts
async ({ workspace, shell }) => {
  const [config, status] = await Promise.allSettled([
    workspace.read("optional.config.json", { format: "raw" }),
    shell.execFile("git", ["status", "--short"]),
  ]);
  return { config, status };
}
```

### Capabilities

- `workspace`
  - `read(file, { format?: "hashed" | "raw", offset?, limit? })` — hashed line anchors by default with a whole-file revision; use raw for machine parsing
  - `edit(file, { revision, changes })` — revision-checked anchored replacements, insertions, deletion, rewriting, and creation
  - `batch(operations, { failure?: "fail-fast" | "settled" })` — concurrent all-read batches or transactional all-edit batches; mixed batches are rejected and both modes return `{ results }`
  - `search(query, options?)` — bounded structured text search with interruptible regex matching and context
  - `list(path?)`
  - `glob(pattern | patterns, { limit?, dot?, onlyFiles?, ignore? })` — deterministic bounded entries with truncation metadata
  - `stat(path)`
- `shell`
  - `exec(command, { cwd?, timeoutMs?, raise?, maxBytes?, maxLines?, truncate? })` — shell syntax with caller-controlled output budgets; set `raise: true` to throw on nonzero exit
  - `execFile(program, args, { cwd?, timeoutMs?, raise?, maxBytes?, maxLines?, truncate? })` — argument-safe direct execution with the same bounded output controls
- `http`
  - `request(url, { method?, headers?, body?, maxBytes? })` — caller-selected body limit below the host maximum
- `ui`
  - `confirm(title, message)`
  - `input(title, placeholder?)`
  - `select(title, options)`
  - `notify(message, "info" | "warning" | "error")`
- `context`
  - `get()` — cwd, mode, model, thinking level, session file, and saved function names

Paths are resolved relative to Pi's current working directory. Absolute paths remain possible, matching Pi's normal tools. Workspace mutation results report slash-normalized paths relative to that working directory; targets outside it are represented with `../` segments.

Read metadata uses sparse defaults: an omitted offset means 1, omitted totalLines means it equals lines, and omitted hasMore or truncated means false. Line endings and final-newline details stay internal to the edit engine.

### Hashed reads and edits

Hashed reads render each selected line as `line:hash|content` and return a revision for the complete UTF-8 file. In structured TUI results, the `line:hash|` prefix is dimmed and wrapped content uses a hanging indent aligned with the original content column:

```text
41:k3F9q|function example() {
42:7Qa2m|  return true;
43:p91Xs|}
```

Use those opaque anchors and the revision in a later edit. All anchors resolve against the original revision, every change validates before writing, overlapping changes are rejected, and changes apply bottom-up:

```ts
await workspace.edit("src/example.ts", {
  revision: "J8xM2pQa7vL4",
  changes: [
    { kind: "replace", start: "42:7Qa2m", content: "  return false;" },
    { kind: "insertAfter", anchor: "43:p91Xs", content: "export { example };" },
  ],
});
```

Supported change kinds are `replace`, `delete`, `insertBefore`, `insertAfter`, `replaceFile`, and `deleteFile`. An end anchor extends a replacement or deletion range; otherwise it targets one line. Use `revision: null` with a sole `replaceFile` change to create a missing file. Existing-file rewrites and deletion require the current revision. Anchored content uses `\n`, which pit converts to the file's dominant line ending while preserving untouched bytes.

Search matches and context lines include anchors, and each match includes its file revision, so search results can feed directly into edit. Read batches contain only `{ kind: "read", file, options? }` operations; edit batches contain only `{ kind: "edit", file, changes }` operations and validate every file before the first commit. Both return `{ results }` with ordered `{ kind, index, ok, value? }` entries; successful entries include `value`, while settled read failures omit it and include `error`.

## Reusable functions

Name a top-level function to execute it and save it automatically:

```ts
async function runTests({ shell }, input: { coverage?: boolean } = {}) {
  return shell.exec(input.coverage ? "npm run coverage" : "npm test", { raise: true });
}
```

To define a reusable function without running it, set `saveOnly: true`. Save-only definitions are statically validated and persisted immediately; top-level `params` are not accepted:

```json
{
  "code": "async function runChecks({ shell }) { return shell.execFile('npm', ['test'], { raise: true }); }",
  "saveOnly": true
}
```

If the named function needs input on its first execution, provide optional top-level `params`. Pit validates the value against an annotated second parameter and passes it through:

```json
{
  "code": "async function inspect({ workspace }, input: { file: string }) { return workspace.read(input.file, { format: 'raw' }); }",
  "params": { "file": "README.md" }
}
```

Later calls invoke it as ordinary TypeScript with capabilities already bound:

```ts
runTests()
runTests({ coverage: true })
```

Named functions normally stage validation and initial execution, then persist as non-context session entries only after execution succeeds. With `saveOnly: true`, a named function is statically validated and persisted without execution; redefining in save-only mode likewise replaces it after static validation. Functions survive reloads and follow the active session branch. Replacements are rejected when they invalidate dependents. Each branch is limited to 64 functions, 100 KB per function, and 1 MB of combined saved source. Successful tool results include a compact catalog of active invocation signatures; names are also available from `context.get().savedFunctions`. Only referenced definitions and their transitive dependencies are injected as typed lexical bindings into each fresh restricted child process.

### Composing workflows

Saved functions can call one another. When a sequence such as validation, staging, committing, and pushing recurs, prefer a higher-level named function such as `publishChanges` over separate command wrappers. Give composed functions typed input and use `shell.exec(command, { raise: true })` for stages that must succeed; a nonzero exit then stops the workflow automatically. Return a structured summary of successful stages. This keeps reusable primitives such as `runValidation` while adding workflows named after user intent.

### Managing saved functions

Use `/functions` in the TUI to list branch-local saved functions, inspect syntax-highlighted source, and delete definitions. Command forms are also available:

```text
/functions list
/functions show runValidation
/functions delete runValidation
```

Deletion appends branch-local tombstones, survives reloads, and confirms before cascading to saved functions that depend on the deleted definition.

## Isolation model

Every invocation gets a new Node process with:

- no filesystem access except loading the fixed sandbox runner;
- no direct network access;
- no subprocess, worker, native addon, inspector, or WASI access;
- a minimal environment without the parent process's credentials;
- a memory ceiling and wall-clock timeout.

Filesystem, command, HTTP, and UI effects exist only as injected RPC capabilities. Destructuring `shell` is intentionally powerful—it is the explicit equivalent of choosing Pi's normal bash tool.

This is stronger than `node:vm`, which is not a security boundary, and avoids a native `isolated-vm` dependency. It is still an application sandbox rather than a container or VM; deployments with hostile models or multi-tenant workloads should put the entire Pi process in an OS sandbox as well.

## Development

```sh
npm run check
npm test
npm run coverage
npm run capabilities:generate
npm run biome:fix
```

`npm run check` first verifies that the generated capability contract is current, then runs TypeScript plus Biome with the `all` lint preset, import organization, formatting, and warnings treated as errors. The configuration disables only rules that conflict with the Node sandbox, generated ambient contract, test fixtures, or intentional control-flow patterns.

Pull requests and pushes to `main` run the same type-check and coverage gate in GitHub Actions. When branch protection is available, configure `main` to require the `test` check before merging.

## License

[MIT](LICENSE)
