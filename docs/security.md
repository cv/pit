# Security model

[Documentation index](README.md) · [Vulnerability reporting and supported releases](../SECURITY.md)

This document explains runtime authority. It is not the vulnerability-reporting policy.

## Authored code and host authority

Authored functions use a portable JavaScript contract: standard language globals, bounded `setTimeout`, and `console.log/warn/error`. Node globals such as `process`, `require`, and `Buffer` are not available; use injected functions for host operations. Console output is discarded—return structured diagnostics when they need to be visible.

Submitted TypeScript runs in a fresh QuickJS VM, compiled to WebAssembly and running in its own worker thread, through Pi's codemode sandbox:

- The VM has no filesystem, environment, network, module loading, or stdio.
- The guest cannot start subprocesses, workers, or native addons.
- Each invocation receives a fresh worker, VM, memory limit, and wall-clock deadline.
- The deadline and explicit cancellation terminate the worker, interrupting guest code.
- Guest requests, host responses, total calls, and concurrent calls are bounded.

Filesystem, command, HTTP, and UI effects are available only through host-authorized injected functions. Calls and protocol frames have size and concurrency limits. Timeout and cancellation signals propagate to both the sandbox and cooperative host operations.

The sandbox restricts direct access. It does not make host functions harmless. The `git` and `shell` functions run commands with the permissions of the Pi process. Git hooks and Git network operations can have external effects. Workspace methods accept absolute paths and paths outside the working directory. The `http` function can request any destination that the host can reach.

Dependency destructuring makes intent visible. It is not an approval boundary. Review generated calls before execution when an operation can affect sensitive data or systems.

This isolation is stronger than `node:vm`, which is not a security boundary. The sandbox worker runs inside Pi's process, so a defect in Node, V8, or the sandbox can still affect the host. It does not replace a container, virtual machine, or operating-system sandbox. If you use a hostile model or a multi-tenant workload, use an additional operating-system boundary.

Report suspected vulnerabilities privately as described in [SECURITY.md](../SECURITY.md).

## Runtime supply chain

The runtime is Pit's npm dependency `@earendil-works/pi-codemode`, with the QuickJS Wasm module from `quickjs-wasi`. Pi installs them with Pit's locked versions from the npm registry; Pit downloads no other artifacts and loads no native addon. Locked versions do not make third-party extension source trustworthy.

See [configuration](configuration.md#runtime-installation) for runtime installation and [architecture](architecture.md) for the internal dispatch and isolation implementation.
