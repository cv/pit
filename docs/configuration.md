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

The `allowedTools` list names explicit exceptions that the model sees directly. Names are case-sensitive; `*` matches any sequence. Pi's tool restrictions still apply. An empty list grants no exceptions. To use Pi's `codemode` alongside Pit, for example, add `"codemode"`.

Set user-wide `allowedTools` defaults in `$PI_CODING_AGENT_DIR/pit.json` (`~/.pi/agent/pit.json`); they apply in untrusted projects too. A trusted project's list replaces these defaults: omit the key to inherit them, or use `[]` to clear them. An invalid or unreadable file is reported as a warning; a broken project file grants no exceptions rather than inheriting the defaults. Function `paths` are project-only: Pit ignores them in the user file and warns.

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

Pit runs TypeScript in a QuickJS VM from Pi's codemode sandbox (`@earendil-works/pi-codemode`), compiled to WebAssembly. It is a regular npm dependency that Pi installs with Pit on any platform Node supports: nothing is downloaded at install time, and no native addon is loaded.

| Environment variable  | Purpose                                                          |
| --------------------- | ---------------------------------------------------------------- |
| `PI_CODING_AGENT_DIR` | Pi's user data directory, also the root for Pit's user functions |

For installation failures, see [troubleshooting](troubleshooting.md).
