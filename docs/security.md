# Security model

[Documentation index](README.md) · [Vulnerability reporting and supported releases](../SECURITY.md)

This document explains runtime authority. It is not the vulnerability-reporting policy.

## Authored code and host authority

Authored functions use a portable JavaScript contract: standard language globals, bounded `setTimeout`, and `console.log/warn/error`. Node globals such as `process`, `require`, and `Buffer` are not available; use injected functions for host operations. Wasmtime discards console output without accessing host stdio—return structured diagnostics when they need to be visible.

Submitted TypeScript runs in a fresh QuickJS runtime inside a bounded Wasmtime store:

- The Wasm component has no inherited filesystem, environment, network, arguments, or stdio.
- The guest cannot start subprocesses, workers, or native addons.
- Each invocation receives a fresh store, QuickJS runtime, fuel budget, memory limit, and wall-clock deadline.
- Explicit cancellation advances the execution epoch and interrupts guest code.
- Guest requests, host responses, total calls, and concurrent calls are bounded.

Filesystem, command, HTTP, and UI effects are available only through host-authorized injected functions. Calls and protocol frames have size and concurrency limits. Timeout and cancellation signals propagate to both Wasmtime and cooperative host operations.

The sandbox restricts direct access. It does not make host functions harmless. The `git` and `shell` functions run commands with the permissions of the Pi process. Git hooks and Git network operations can have external effects. Workspace methods accept absolute paths and paths outside the working directory. The `http` function can request any destination that the host can reach.

Dependency destructuring makes intent visible. It is not an approval boundary. Review generated calls before execution when an operation can affect sensitive data or systems.

This isolation is stronger than `node:vm`, which is not a security boundary. Wasmtime runs through a native addon in Pi's process, so a native runtime defect can still crash the host. It does not replace a container, virtual machine, or operating-system sandbox. If you use a hostile model or a multi-tenant workload, use an additional operating-system boundary.

Report suspected vulnerabilities privately as described in [SECURITY.md](../SECURITY.md).

## Runtime supply chain

The installer verifies SHA-256 checksums against the matching release's manifest before activating downloaded addons and the QuickJS component. This checks artifact integrity against that release; it does not make third-party extension source trustworthy. Missing or unsupported prebuilds disable TypeScript execution with an explanatory error; there is no fallback runtime.

See [configuration](configuration.md#runtime-installation) for local runtime overrides and [architecture](architecture.md) for the internal dispatch and isolation implementation.
