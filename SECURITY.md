# Security policy

## Supported versions

Pit provides security fixes for the [latest tagged release](https://github.com/cv/pit/releases/latest). Earlier releases are not supported. See the [README](README.md#install-and-update) for current runtime requirements.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability reporting flow at:

https://github.com/cv/pit/security/advisories/new

Include the affected version, reproduction steps, impact, and any suggested mitigation. You should receive an initial response within seven days. Please allow time for a fix and coordinated disclosure before publishing details.

## Security model

Submitted TypeScript runs in a fresh QuickJS runtime inside a bounded Wasmtime store. Host functions can still change files, execute commands, and reach the network with the Pi process's permissions. Dependency injection is not an approval boundary, and the sandbox does not replace operating-system isolation.

Read the [security model](docs/security.md) for the guarantees, limitations, host authority, and runtime supply chain.
