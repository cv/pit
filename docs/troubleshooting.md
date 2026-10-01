# Troubleshooting

[Documentation index](README.md) · [Configuration](configuration.md)

For reproducible bugs, open a [GitHub issue](https://github.com/cv/pit/issues) with the Pit, Pi, and Node versions, the relevant error, and a minimal reproduction. Remove secrets and private data. Report suspected vulnerabilities [privately](../SECURITY.md).

## Common symptoms

### Pi reports an unsupported Node version

Run `node --version` and compare it with the [current requirements](../README.md#install-and-update). Install a supported Node version and start Pi again with it.

### Git cannot install or update the package

Confirm that `https://github.com/cv/pit` is reachable. Run `pi update git:github.com/cv/pit`, then `/reload`. If a pinned tag is unavailable, verify that the tag exists in [GitHub Releases](https://github.com/cv/pit/releases). Restart rather than reload after a native runtime update.

### An edit reports a revision or anchor mismatch

Submit a new read or search call. Use only the new revision and anchors in the next edit. Do not reuse anchors from an earlier read.

### A result is truncated

Oversized results stay valid JSON within the output budget. Omitted parts are marked `… N lines omitted …`, `… N bytes omitted …`, `… N items omitted …`, or `… N keys omitted …` and are not retained. Reduce the requested line count or result limit. Narrow the file path, glob, or search query. Return a summary instead of a complete data set.

### A UI method fails

Run Pi in a mode that provides a UI. Do not use a UI function in a non-UI mode.

### A saved function is unavailable

Run `/functions list` and confirm that the function exists on the active session branch. Call `context.get()` to inspect the active function names.

A function marked `(unavailable)` injects a tool that isn't callable now. The error names the reason. Enable the MCP server or extension that provides the tool, or wait for its server to connect; see [functions that inject tools](saved-functions.md#functions-that-inject-tools).

### A tool is missing from `tools`

Search for it with `toolIndex.search`: its identifier may differ from the tool name, or it may be one of the [tools Pit doesn't bind](usage.md#results). Check that the extension or MCP server providing it is enabled, for example with `/mcp`. With Pi 0.99.2 or newer, MCP servers without `direct` tools connect in the background after Pi starts, so a call in the first moments of a session can miss their tools; retrying after the server connects works ([#207](https://github.com/cv/pit/issues/207)).

### Pit loads, but TypeScript reports a missing runtime

Read the runtime error for the missing or unloadable artifact. Verify access to GitHub release assets and that your OS/architecture has a prebuild. From the installed Pit package directory, rerun `node scripts/install-wasmtime.mjs`, then restart Pi. Check that any `PIT_WASMTIME_ADDON` and `PIT_WASMTIME_COMPONENT` overrides are both set and refer to matching artifacts. See [runtime installation](configuration.md#runtime-installation).

### An update appears not to take effect

Confirm whether the package is pinned to a tag; package updates do not move pinned references. For source changes, run `/reload`. After a native addon update, restart Pi instead: Node caches loaded native modules.

### A project or user function does not load

For project functions, check both Pi's project trust and `projectFunctions.enabled` in `.pi/pit.json`. User functions load automatically from the active Pi agent directory. Inspect `/functions` for loading diagnostics: an invalid definition reserves its identifier rather than silently exposing a lower implementation. Fix the source or explicitly remove the definition, then reload. See [configuration](configuration.md) and [saved functions](saved-functions.md).
