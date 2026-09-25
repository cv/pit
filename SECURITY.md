# Security policy

## Supported versions

Pit provides security fixes for the latest tagged release.

| Version          | Supported |
| ---------------- | --------- |
| 0.16.x           | Yes       |
| Earlier releases | No        |

Pit requires Node.js 22.19 or newer as the Pi extension host. The installer verifies SHA-256 checksums before activating release-built Wasmtime addons for Linux, macOS, and Windows on ARM64 or x64. Missing or unsupported prebuilds disable TypeScript execution with an explanatory error; there is no fallback runtime.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability reporting flow at:

https://github.com/cv/pit/security/advisories/new

Include the affected version, reproduction steps, impact, and any suggested mitigation. You should receive an initial response within seven days. Please allow time for a fix and coordinated disclosure before publishing details.

## Security model

Submitted TypeScript runs in a fresh QuickJS runtime inside a bounded Wasmtime store and can affect the host only through host-authorized injected functions. The component receives restricted WASI Preview 2 bindings with no inherited filesystem, environment, network, arguments, or stdio. This is an application boundary, not a container, virtual machine, or operating-system sandbox. Wasmtime is loaded as a native addon in Pi's process, so native runtime defects share the host process's crash boundary.

Host capabilities remain powerful. In particular:

- `shell`, `git`, and `npm` can execute code with the Pi process's permissions.
- Git hooks and network operations can have external effects.
- Workspace methods may access absolute paths or paths outside the current project.
- HTTP requests are not restricted by a destination allowlist.
- Extensions themselves execute with host permissions.

Use an additional operating-system isolation boundary for hostile models, untrusted extensions, multi-tenant workloads, or sensitive environments.
