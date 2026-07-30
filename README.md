# pit

A Pi extension that replaces the normal coding tools with one tool: `typescript`.

The model submits a TypeScript function. That function runs in a fresh, permission-restricted process and receives the useful host capabilities it explicitly destructures:

```ts
async ({ workspace, shell }) => {
  const manifests = await workspace.glob("**/package.json", {
    ignore: ["**/node_modules/**"],
  });
  const status = await shell.exec("git status --short");

  return { manifests, status };
}
```

The function's return value becomes the tool result. This lets the model batch several operations and perform ordinary computation without repeatedly crossing the model/tool boundary.

## Install and run

```sh
npm install
pi --no-builtin-tools -e ./src/index.ts
```

The extension also sets the active tool list to only `typescript` at session start, so `--no-builtin-tools` is defensive rather than required. To install it as a project-local Pi package, keep the repository under the project and add its path to Pi's package settings.

Requires Node 22 or newer because the sandbox uses Node's permission model.

## Function contract

The `code` argument must evaluate to a function expression and cannot contain imports:

```ts
async ({ workspace, shell }) => {
  // Use only the capabilities requested here.
  return jsonSerializableValue;
}
```

Each destructured capability is a local proxy. Calling one of its methods performs an RPC to the trusted extension process. Unknown capabilities and methods fail closed.

### Capabilities

- `workspace`
  - `readText(path, { offset?, limit? })`
  - `writeText(path, contents)`
  - `editText(path, [{ oldText, newText }, ...])`
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
  - `get()` — cwd, mode, model, thinking level, and session file

Paths are resolved relative to Pi's current working directory. Absolute paths remain possible, matching Pi's normal tools.

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
