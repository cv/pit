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

In the Pi TUI, each tool call shows the generated TypeScript as its arguments stream in, and successful result values are rendered as syntax-highlighted JSON. Collapsed views show the first 12 lines; press `Ctrl+O` to expand the row and inspect the complete source and result.

## Install and run

```sh
npm install
pi --no-builtin-tools -e ./src/index.ts
```

The extension also sets the active tool list to only `typescript` at session start, so `--no-builtin-tools` is defensive rather than required. To install it as a project-local Pi package, keep the repository under the project and add its path to Pi's package settings.

Requires Node 22 or newer because the sandbox uses Node's permission model.

## Function contract

The `code` argument must be a TypeScript expression and cannot contain imports. Use an anonymous function for one-shot work:

```ts
async ({ workspace, shell }) => {
  // Use only the capabilities requested here.
  return jsonSerializableValue;
}
```

The expression is contextually type-checked before execution. No source annotations are required: destructured capabilities automatically receive the types declared in [`src/capability-contract.d.ts`](src/capability-contract.d.ts). Validation catches unknown capabilities and methods, invalid arguments, missing awaits, and non-JSON-compatible results with source locations.

Each destructured capability is a local proxy. Calling one of its methods performs an RPC to the trusted extension process. Calls begin immediately, so independent operations should be started together with `Promise.all`. Unknown capabilities and methods also fail closed at runtime.

### Capabilities

- `workspace`
  - `readText(path, { offset?, limit? })`
  - `writeText(path, contents)`
  - `editText(path, [{ oldText, newText }, ...])`
  - `batch([{ kind: "write" | "edit", path, ... }, ...])` — transactional multi-file mutation
  - `applyPatch(unifiedDiff)` — transactional multi-file unified patch
  - `list(path?)`
  - `glob(pattern | patterns, { dot?, onlyFiles?, ignore? })`
  - `stat(path)`
- `shell`
  - `exec(command, { cwd?, timeoutMs? })`
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
  return shell.exec(input.coverage ? "npm run coverage" : "npm test");
}
```

Later calls invoke it as ordinary TypeScript with capabilities already bound:

```ts
runTests()
runTests({ coverage: true })
```

Named functions are persisted as non-context session entries, survive reloads, and follow the active session branch. Redefining the same name replaces its source. Each branch is limited to 64 functions, 100 KB per function, and 1 MB of combined saved source. Active saved names are available from `context.get().savedFunctions`. Saved definitions are injected as typed lexical bindings into each fresh restricted child process, so saved functions can call one another without retaining process state.

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
```
