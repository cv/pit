# Pit documentation

New to Pit? Start with the [project README](../README.md) for what it does, installation, and a first workflow.

## Using Pit

| Guide                                 | Read it when you want to…                                                                         |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [Usage](usage.md)                     | Build a call, pass input, sequence work, edit safely, or understand a result                      |
| [Saved functions](saved-functions.md) | Retain and compose workflows, promote them, or understand scopes and overrides                    |
| [Configuration](configuration.md)     | Choose an installation scope, allow other tools, enable project functions, or configure a runtime |
| [Reference](reference.md)             | Look up tool parameters, global methods, defaults, return shapes, and limits                      |
| [Security model](security.md)         | Understand the sandbox's guarantees and the authority host functions retain                       |
| [Troubleshooting](troubleshooting.md) | Diagnose a symptom and recover                                                                    |

You can use Pit by talking to the agent normally. The call-authoring guides are for understanding or writing the TypeScript it runs, not prerequisites for getting started.

## Developing Pit

- [Contributing](../CONTRIBUTING.md): prerequisites, local setup, checks, and PR expectations.
- [Architecture](architecture.md): runtime flow, internal boundaries, invariants, and where to make a change.
- [Releasing](releasing.md): preparation, publication, and installed-tag acceptance.
- [Native runtime](../native/wasmtime-executor/README.md): subsystem build and smoke-test instructions.
- [Repository workflow functions](../.pi/functions/README.md): this repository's maintainer helpers, not the general saved-functions API.

## Background and policies

- [I Wasn't Trying to Build an App](case_study/): a historical account of growing a music-recommendation system through Pit use, with sanitized session artifacts.
- [Changelog](../CHANGELOG.md) and [GitHub releases](https://github.com/cv/pit/releases).
- [Security policy](../SECURITY.md): supported releases and private vulnerability reporting.
- [Code of conduct](../CODE_OF_CONDUCT.md).

Documentation describes the source revision you are browsing. Use a release tag to read the documentation for that release. Historical case studies describe their recorded sessions, not the current API.
