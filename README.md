# pit

A Pi extension that replaces the normal coding tools with one tool: `typescript`.

The model submits a TypeScript expression that runs in a fresh, permission-restricted process. One-shot functions explicitly destructure the host capabilities they need:

```ts
async ({ workspace, shell }) => {
  const [manifests, status] = await Promise.all([
    workspace.glob("**/package.json", {
      ignore: ["**/node_modules/**"],
    }),
    shell.exec("git status --short"),
  ]);

  return { manifests, status };
}
```

The expression's resolved value becomes the tool result. This lets the model batch several operations and perform ordinary computation without repeatedly crossing the model/tool boundary.

In the Pi TUI, each tool call shows the generated TypeScript as its arguments stream in, and successful result values are rendered as syntax-highlighted JSON. Collapsed views show the first 12 lines; press `Ctrl+O` to expand the row and inspect the complete source and result. Calls to saved functions also show the injected definitions and transitive saved dependencies in expanded mode, with per-function and total display limits.

## Install

Pit is distributed as a Git-based Pi package. The repository is private, so installation requires repository access and working GitHub SSH credentials.

Install the pinned release globally:

```sh
pi install git:git@github.com:cv/pit.git@v0.2.0
```

Install for the current project:

```sh
pi install -l git:git@github.com:cv/pit.git@v0.2.0
```

Try it for one run without changing settings:

```sh
pi -e git:git@github.com:cv/pit.git@v0.2.0
```

For local development:

```sh
npm install
pi -e ./src/index.ts
```

The extension intentionally replaces the active coding tool set with only `typescript` at session start. Review the source before installation: Pi extensions execute with the host process's permissions.

Requires Node 22 or newer because the sandbox uses Node's permission model.

## Function contract

The `code` argument must be a TypeScript expression and cannot contain imports. Use an anonymous function for one-shot work:

```ts
async ({ workspace, shell }) => {
  // Use only the capabilities requested here.
  return jsonSerializableValue;
}
```

The expression is contextually type-checked before execution. No source annotations are required: destructured capabilities automatically receive the types in generated [`src/capability-contract.d.ts`](src/capability-contract.d.ts). The authoritative method declarations, dispatch metadata, arity constraints, and model-facing summaries live in [`src/capability-registry.ts`](src/capability-registry.ts). Validation catches unknown capabilities and methods, invalid arguments, missing awaits, and non-JSON-compatible results with source locations.

Each destructured capability is a local proxy. Calling one of its methods performs a size- and concurrency-bounded RPC to the trusted extension process. Calls begin immediately, and pit waits for outstanding calls before accepting a successful result. Timeout and cancellation signals propagate to cooperative host operations. Use `Promise.all` when any failed operation should fail the invocation; use `Promise.allSettled` or a local catch for optional exploratory probes. Sequence dependent calls and conflicting mutations. Unknown capabilities and methods also fail closed at runtime.

For example, preserve successful inspection results when an optional file may not exist:

```ts
async ({ workspace, shell }) => {
  const [config, status] = await Promise.allSettled([
    workspace.readText("optional.config.json"),
    shell.execFile("git", ["status", "--short"]),
  ]);
  return { config, status };
}
```

### Capabilities

- `workspace`
  - `readText(path, { offset?, limit? })`
  - `writeText(path, contents)`
  - `editText(path, [{ oldText, newText }, ...])`
  - `batch([{ kind: "write" | "edit", path, ... }, ...])` — transactional multi-file mutation
  - `applyPatch(unifiedDiff)` — transactional multi-file unified patch
  - `search(query, options?)` — bounded structured text search with interruptible regex matching and context
  - `list(path?)`
  - `glob(pattern | patterns, { limit?, dot?, onlyFiles?, ignore? })` — deterministic bounded entries with truncation metadata
  - `stat(path)`
- `shell`
  - `exec(command, { cwd?, timeoutMs?, raise? })` — shell syntax; set `raise: true` to throw on nonzero exit
  - `execFile(program, args, { cwd?, timeoutMs?, raise? })` — argument-safe direct execution without shell interpolation
- `http`
  - `request(url, { method?, headers?, body? })`
- `ui`
  - `confirm(title, message)`
  - `input(title, placeholder?)`
  - `select(title, options)`
  - `notify(message, "info" | "warning" | "error")`
- `context`
  - `get()` — cwd, mode, model, thinking level, session file, and saved function names

Paths are resolved relative to Pi's current working directory. Absolute paths remain possible, matching Pi's normal tools.

## Reusable functions

Name a top-level function to execute it and save it automatically:

```ts
async function runTests({ shell }, input: { coverage?: boolean } = {}) {
  return shell.exec(input.coverage ? "npm run coverage" : "npm test", { raise: true });
}
```

If the named function needs input on its first execution, provide optional top-level `params`. Pit validates the value against an annotated second parameter and passes it through:

```json
{
  "code": "async function inspect({ workspace }, input: { path: string }) { return workspace.readText(input.path); }",
  "params": { "path": "README.md" }
}
```

Later calls invoke it as ordinary TypeScript with capabilities already bound:

```ts
runTests()
runTests({ coverage: true })
```

Named functions are staged for validation and initial execution, then persisted as non-context session entries only after that execution succeeds. They survive reloads and follow the active session branch. Redefining the same name replaces its source only after the replacement and its dependents validate and the replacement executes successfully. Each branch is limited to 64 functions, 100 KB per function, and 1 MB of combined saved source. Active saved names are available from `context.get().savedFunctions`. Only referenced definitions and their transitive dependencies are injected as typed lexical bindings into each fresh restricted child process.

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
