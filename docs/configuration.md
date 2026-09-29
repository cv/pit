# Configuration

[Documentation index](README.md) · [Installation quickstart](../README.md#install-and-update)

## Installation scope

The README owns the current requirements and pinned install example. For other installation scopes:

```sh
# Try it for one session without changing your settings
pi -e git:github.com/cv/pit

# Install for the current project only (writes .pi/settings.json)
pi install -l git:github.com/cv/pit
```

Pi manages package installation in its settings; `.pi/pit.json` below configures Pit behavior, not package installation. Project-local packages and configuration require Pi's project trust.

## Project configuration

Pit reads a trusted project's `.pi/pit.json`. This example enables project functions and allows a family of other tools alongside `typescript`:

```json
{
  "projectFunctions": { "enabled": true },
  "allowedTools": ["goal_*"]
}
```

Run `/reload` after changing configuration.

### Allow other tools

Pit declares only `typescript` to the model by default. Other active tools, including Pi's built-in tools, extension tools, and the `codemode` and `tool_search` tools, stay active but are hidden from the model. Extensions that check for their tools in the active set keep working, and hidden tools remain callable by other tools.

The `allowedTools` list names explicit exceptions that the model sees directly. Names are case-sensitive; `*` matches any sequence. Pi's tool restrictions still apply. Empty or invalid configuration grants no exceptions. To use Pi's `codemode` alongside Pit, for example, add `"codemode"`.

Pit also leaves these tools declared, because they reflect explicit choices:

- MCP tools configured with `"exposure": "direct"` in `mcp.json`. MCP tools use `codemode` exposure by default.
- Tools that `tool_search` loaded, when `tool_search` is allowed.

Pit resolves `allowedTools` at session start. It activates `typescript` and the matching tools, and adds them again after `/tree` navigation, because Pi restores the tool set recorded on the destination branch. It does not deactivate tools that Pi's `defaultTools` setting or other extensions activated.

### Enable project functions

Project functions are disabled by default. Set `projectFunctions.enabled` to `true` only after reviewing and trusting the project's `.pi/functions/` source. Pit requires both explicit opt-in and Pi's project-trust check.

Disabling project functions leaves their files in place. A named function submitted through the tool is session-scoped; [promotion](saved-functions.md#share-trusted-project-functions) explicitly writes it to persistent storage.

## User functions and storage

User functions load automatically from `${PI_CODING_AGENT_DIR}/functions/`, defaulting to `~/.pi/agent/functions/`. There is no user enablement flag, and project configuration does not disable them.

External source edits are picked up at session start or `/reload`. See [saved functions](saved-functions.md) for path-derived names, scope precedence, dependency restrictions, and confirmed user promotion/removal.

## Runtime installation

Pit runs TypeScript in a QuickJS guest on a prebuilt Wasmtime addon. The installer downloads this platform's addon and the shared guest from the matching GitHub release, or the latest release for an unpublished package version. It verifies release checksums before activating the files. Missing or unsupported prebuilds leave Pit loaded, but every TypeScript call explains why the runtime is unavailable; there is no fallback executor.

| Environment variable            | Purpose                                                                            |
| ------------------------------- | ---------------------------------------------------------------------------------- |
| `PIT_WASMTIME_ADDON`            | Path to a local Wasmtime native addon; set together with the component path        |
| `PIT_WASMTIME_COMPONENT`        | Path to the matching local QuickJS Wasm component                                  |
| `PIT_WASMTIME_INSTALL_STRICT=1` | Make runtime installation fail rather than warn when artifacts cannot be installed |
| `PI_CODING_AGENT_DIR`           | Pi's user data directory, also the root for Pit's user functions                   |

Restart Pi after replacing a native addon; `/reload` alone cannot evict Node's loaded native module. For local runtime builds, see the [native runtime guide](../native/wasmtime-executor/README.md). For installation failures, see [troubleshooting](troubleshooting.md).
