# Security policy

## Supported versions

Pit provides security fixes for the latest tagged release.

| Version          | Supported |
| ---------------- | --------- |
| 0.15.x           | Yes       |
| Earlier releases | No        |

Pit v0.15.0 is tested with Node.js 22.19 or newer and Pi 0.85.1. Other Pi versions may work but are not part of the tested compatibility target.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability reporting flow at:

https://github.com/cv/pit/security/advisories/new

Include the affected version, reproduction steps, impact, and any suggested mitigation. You should receive an initial response within seven days. Please allow time for a fix and coordinated disclosure before publishing details.

## Security model

Submitted TypeScript runs in a fresh process under Node's permission model and can affect the host only through injected capabilities. This is an application boundary, not a container, virtual machine, or operating-system sandbox.

Host capabilities remain powerful. In particular:

- `shell`, `git`, and `npm` can execute code with the Pi process's permissions.
- Git hooks and network operations can have external effects.
- Workspace methods may access absolute paths or paths outside the current project.
- HTTP requests are not restricted by a destination allowlist.
- Extensions themselves execute with host permissions.

Use an additional operating-system isolation boundary for hostile models, untrusted extensions, multi-tenant workloads, or sensitive environments.
