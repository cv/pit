# Pit on pi-durable hosts

Pit is a Pi extension, but its `typescript` tool also runs on hosts built on [`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable), such as [pi-action](https://github.com/cv/pi-action), which keeps one durable conversation per GitHub issue or pull request. The `pit/durable` entry point exports a pi-durable extension: the tool, its usage guidelines, and the user and project function catalogs as prompt sections.

This page covers what works there, what doesn't, and the security differences from Pi. The [reference](reference.md) describes the globals themselves.

## Install and load

Install Pit next to pi-durable in the host project. Pit is not published to npm; install it from GitHub, pinned to a release tag (`github:cv/pit#vX.Y.Z`) for reproducible hosts:

```sh
npm install @earendil-works/pi-durable github:cv/pit
```

Pit has no install scripts, so `--ignore-scripts` installs it completely.

Pit runs from its TypeScript sources, so the host loads it through a TypeScript-aware loader such as [jiti](https://github.com/unjs/jiti), or Node's type stripping with a resolver that maps `./module.js` imports to `.ts` files. Then install the extension in the Harness registry:

```ts
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { createPitDurableExtension } from "pit/durable";

const registry = createRegistry();
registry.install(createPitDurableExtension({ trustProject: false }));
const harness = await Harness.open(storage, { models, registry }, context);
```

Hosts that load extensions generically find the entry in `package.json` under `pi.durable` and call its `createPiDurableExtension` export, an alias of `createPitDurableExtension`. Pi itself keeps loading `pi.extensions`.

The durable entry imports neither Pi's coding agent, Pi's TUI, nor TypeBox, and needs pi-durable only for types. npm still installs Pit's required peer dependencies (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`) unless the host installs with `--legacy-peer-deps`; the durable entry never loads them.

## Options

| Option         | Default                                                                        | Effect                                                                                                                                                                               |
| -------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cwd`          | the call's environment, then the agent's, then the process's working directory | Working directory for programs, commands, and project functions.                                                                                                                     |
| `agentDir`     | `PI_CODING_AGENT_DIR`, else `~/.pi/agent`                                      | Where user functions (`functions/`) and the user-wide `pit.json` load from, as on Pi.                                                                                                |
| `trustProject` | `false`                                                                        | Loads the project's `.pi/pit.json` and `.pi/functions` and lets programs save project functions. Set it only for repositories whose code you would run anyway.                       |
| `ui`           | none                                                                           | Dialogs with the signatures of Pi's `ctx.ui.confirm`, `select`, `input`, and `notify`. Without it, `ui.*` throws `UI is not available in this mode`, as on Pi without a UI.          |
| `log`          | none                                                                           | `info` and `warning` callbacks for what Pi would show as notifications: saved functions that failed to load, an unreadable `pit.json`, and project functions left unloaded by trust. |

## What works

- `workspace.*` except `viewImage`, `shell.*`, `git.*`, `npm.*`, `gh.*`, `http.*`, and the other command globals, in the conversation's working directory.
- Saved functions in every scope. Session functions are conversation entries; user and project functions load from disk as on Pi. `functions.*` manages them.
- `tools.*` and `toolIndex.*` call the agent's other tools through `executeTool()`, so the Harness validates arguments, runs tool hooks, and validates declared structured output. Pit's own tool is model-only (`callers: ["model"]`), and, as on Pi, Pi's file and shell tools (`read`, `bash`, `edit`, `write`, and the like) are left out because Pit's globals replace them.
- `context.get()` reports `mode: "durable"`, no session file, and an extra `hasUI` field, so a program can check for dialogs before asking. The shared type declaration does not include `hasUI` yet; read it with a cast.
- `models.current` and `models.list` read the host's model catalog; every model counts as in scope.
- `runtime.status` and `runtime.completedCalls`. Recovered calls stay in memory for the host process, as on Pi for one session.
- `ui.*` through the host's `ui` option.

Results are plain text for the model plus the same JSON `details` Pi's renderers read: the value, progress, traces, timings, and saved-function changes. Command output streams through `output()` while a call runs. A failed call returns an error result whose text is the root error, as on Pi.

## What doesn't

These throw a `PitDurableUnavailableError` whose message names the global, such as `commands.list is unavailable on pi-durable hosts: the host has no slash commands`:

- `session.*`: context editing and notes are not implemented yet, so the prompt guidelines omit them.
- `commands.*`: pi-durable has no slash commands.
- `models.set`: the host configures the conversation's model.
- Model requests (`models.listOfType`, `models.classify`, `models.generateImages`).
- `workspace.viewImage`. Images that nested tools return are not attached; the result says so.

Pi-only features are absent: renderers and the `/functions` and `/pit-reflect` commands, Pit's skills, `allowedTools` in `pit.json` (the host chooses the tools), and catalog cache holding (pi-durable sends a changed section as a transcript delta).

## Session functions

A saved session function is written to the conversation as a data-only entry of kind `pit-function-definitions`, with the same data as Pi's custom entry: `{ name, source }`, or `{ name, deleted: true }` for a removal. pi-durable appends data-only writes at once, even during a run, and the call waits for them before it reports the change.

The first call in a conversation, per host process, replays these entries from the conversation's whole fork-aware history, so a reopened Harness and a fork see what earlier calls saved, and a fork's later changes stay in the fork. Conversations stay in memory up to a bound, least recently used first out; an evicted conversation replays again on its next call.

## Security notes

Read the [security model](security.md) first; everything there applies. On pi-durable, also:

- **Host effects run in the host process.** Pit's globals read and write files and run commands with Node in the process that runs the Harness, with that process's user, environment, and network access. They do not go through pi-durable's `ExecutionEnv`: a host that gives the agent a container or remote environment does not confine Pit. Run such hosts with Pit only where host-process effects are acceptable.
- **Treat prompts as code.** Whoever can write to the conversation, for example by commenting on an issue that pi-action answers, can ask the model to run commands. Limit who can drive the conversation, and keep secrets the job does not need out of the host's environment.
- **Project trust is off by default.** An untrusted project's `.pi/functions` and `.pi/pit.json` do not load, and programs cannot save project functions. Pull-request checkouts in particular should stay untrusted.
- **No dialogs, no confirmation.** Without `ui`, operations that ask on Pi (user-scope promotion and removal) fail instead of proceeding.
