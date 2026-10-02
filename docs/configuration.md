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

Pit reads a trusted project's `.pi/pit.json`; an untrusted project's file is ignored. This example allows a family of other tools alongside `typescript` and chooses where saved functions live:

```json
{
  "allowedTools": ["goal_*"],
  "paths": {
    "project": ".pi/functions",
    "user": "~/.pi/agent/functions"
  }
}
```

Every key is optional. Run `/reload` after changing configuration. An invalid file is reported as a warning at session start, and Pit uses the defaults instead.

Run `/reload` after changing configuration.

### Allow other tools

Pit declares only `typescript` to the model by default. Other active tools, including Pi's built-in tools, extension tools, and the `codemode` and `tool_search` tools, stay active but are hidden from the model. Extensions that check for their tools in the active set keep working, and hidden tools remain callable by other tools.

The `allowedTools` list names explicit exceptions that the model sees directly. Names are case-sensitive; `*` matches any sequence. Pi's tool restrictions still apply. Empty or invalid configuration grants no exceptions. To use Pi's `codemode` alongside Pit, for example, add `"codemode"`.

Pit also leaves these tools declared, because they reflect explicit choices:

- MCP tools configured with `"exposure": "direct"` in `mcp.json`. MCP tools use `codemode` exposure by default.
- Tools that `tool_search` loaded, when `tool_search` is allowed.

Pit resolves `allowedTools` at session start. It activates `typescript` and the matching tools, and adds them again after `/tree` navigation, because Pi restores the tool set recorded on the destination branch. It does not deactivate tools that Pi's `defaultTools` setting or other extensions activated.

### Choose function directories

`paths` sets the directories Pit loads saved functions from and promotes them to:

| Key             | Default                                                    | Holds              |
| --------------- | ---------------------------------------------------------- | ------------------ |
| `paths.project` | `.pi/functions`                                            | Project functions. |
| `paths.user`    | `$PI_CODING_AGENT_DIR/functions` (`~/.pi/agent/functions`) | User functions.    |

Relative paths resolve against the project root, `~` expands to your home directory, and absolute paths are used as given. Either directory may be outside the project. For example, keep project functions in a separate repository, or give your Rust projects one collection of user functions and your Python projects another:

```json
{ "paths": { "user": "~/pit-functions/rust" } }
```

Project functions load in every trusted project. They run in the same sandbox as session functions, but they are code the project ships, so review `.pi/functions` (or the configured directory) before trusting a project. Removing a definition deletes its file; a named function submitted through the tool stays session-scoped until [promotion](saved-functions.md#share-trusted-project-functions) writes it to a directory.

## User functions and storage

User functions load from `paths.user`, by default `${PI_CODING_AGENT_DIR}/functions/` (`~/.pi/agent/functions/`), in trusted and untrusted projects alike. An untrusted project's `.pi/pit.json` is not read, so it uses the default.

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
