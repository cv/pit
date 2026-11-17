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

| Option         | Default                                                                        | Effect                                                                                                                                                                                                                                                                                           |
| -------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cwd`          | the call's environment, then the agent's, then the process's working directory | Working directory for programs, commands, and project functions.                                                                                                                                                                                                                                 |
| `agentDir`     | `PI_CODING_AGENT_DIR`, else `~/.pi/agent`                                      | Where user functions (`functions/`) and the user-wide `pit.json` load from, as on Pi.                                                                                                                                                                                                            |
| `trustProject` | `false`                                                                        | Loads the project's `.pi/pit.json` and `.pi/functions` and lets programs save project functions. Set it only for repositories whose code you would run anyway.                                                                                                                                   |
| `ui`           | none                                                                           | How people answer questions: `ask` for asynchronous hosts, or blocking `confirm`, `select`, and `input` with the signatures of Pi's `ctx.ui`, plus `notify`. Without any, `ui.*` throws `UI is not available in this mode`, as on Pi without a UI. See [Questions](#questions).                  |
| `log`          | none                                                                           | `info` and `warning` callbacks for what Pi would show as notifications: saved functions that failed to load, an unreadable `pit.json`, and project functions left unloaded by trust.                                                                                                             |
| `images`       | none                                                                           | An `ImageProcessor` that resizes and converts the images `workspace.viewImage` attaches to fit the model, such as `await createNodePhotonImages()` from `@earendil-works/pi-durable/images/node`. Without one, supported images within the byte limit attach as they are. See [Images](#images). |
| `hideTools`    | `true`                                                                         | Tools to stop offering to the model; they stay enabled for other tools. `true` hides pi-durable's coding tools (`read`, `write`, `edit`, `bash`, `powershell`), an array names the tools instead, and `false` hides none. See [Tools the model sees](#tools-the-model-sees).                     |
| `collapse`     | `{ keepRuns: 1, minTokens: 32000 }`                                            | After each run, collapses the tool calls of finished runs older than the newest `keepRuns` to one line each, once the conversation's messages pass `minTokens`. `false` turns it off. See [Collapsing finished runs](#collapsing-finished-runs). |

## What works

- `workspace.*`, `shell.*`, `git.*`, `npm.*`, `gh.*`, `http.*`, and the other command globals, in the conversation's working directory.
- Saved functions in every scope. Session functions are conversation entries; user and project functions load from disk as on Pi. `functions.*` manages them.
- `tools.*` and `toolIndex.*` call the agent's other tools through `executeTool()`, so the Harness validates arguments, runs tool hooks, and validates declared structured output. As on Pi, Pit leaves out itself, other orchestrators (`codemode`, `tool_search`), and the file and shell tools its own globals supersede (`read`, `write`, `edit`, `bash`, `powershell`, `grep`, `find`, `ls`), so programs have one way to read a file or run a command: `workspace.*` and `shell.*`. A `pit_tools` prompt section lists the bound tools.
- `context.get()` reports `mode: "durable"`, no session file, and an extra `hasUI` field, so a program can check for dialogs before asking. The shared type declaration does not include `hasUI` yet; read it with a cast.
- `models.current` and `models.list` read the host's model catalog; every model counts as in scope.
- `session.info`, `outline`, `inspectEntry`, `elide`, `summarize`, `setNote`, and `notes`, as described in [Context editing and notes](#context-editing-and-notes).
- `runtime.status` and `runtime.completedCalls`. Recovered calls stay in memory for the host process, as on Pi for one session.
- `ui.*` and the confirmations `functions.*` asks for, through the host's `ui` option, as [Questions](#questions) describes.

- `workspace.viewImage` attaches images to the result the model receives, with the limits it has on Pi: 10 MiB per source file, 5 MiB encoded per image, and 8 images and 16 MiB encoded per call. Images that `tools.*` calls return attach the same way, also from tools that declare an output schema. With a text-only model the result says the image was left out. See [Images](#images).

### Images

Pit recognizes PNG, JPEG, GIF, WebP, and BMP files by their magic bytes. How it prepares them depends on the `images` option:

- **With a processor**, such as `await createNodePhotonImages()` from `@earendil-works/pi-durable/images/node`, Pit hands it each image with the model's limits: pi-durable's defaults (2000×2000 pixels, 4.5 MiB encoded), overridden by the model's `inputLimits.images.resize` and capped at 5 MiB. The processor resizes and converts the image, and the result notes what changed and how to map coordinates back.
- **Without one**, PNG, JPEG, GIF, and WebP images within the encoded limit attach as they are, as pi-durable's `read` does without a processor. BMP and larger images fail with an error that says no processor is configured.

```ts
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";

registry.install(createPitDurableExtension({ images: await createNodePhotonImages() }));
```

### Tools the model sees

As on Pi, the model sees `typescript` and not the coding tools. By default Pit stops offering pi-durable's coding tools to the model: `read`, `write`, `edit`, `bash`, and `powershell`. It does this with pi-durable wraps that take `"model"` out of each tool's `callers`. The tools stay enabled, and other tools, such as `codemode`, can still call them through `executeTool()`.

- **`allowedTools`** from the user's `<agentDir>/pit.json` and, with `trustProject` and an explicit `cwd`, the project's `.pi/pit.json` names exceptions that stay offered, with the same precedence as on Pi: a project's list replaces the user's, `[]` clears it, and an invalid project file grants no exceptions. Pit reads these files once, when the host creates the extension. Without `cwd` the conversation's directory isn't known yet, so only the user file applies, and Pit warns through `log.warning` if `trustProject` is set.
- **`hideTools`** replaces the hide list, or turns hiding off with `false`. Pit never hides `typescript`, `codemode`, or `tool_search`.
- **Only named tools.** A wrap targets one exact tool name, so tools from other extensions stay offered unless `hideTools` names them. Pi instead hides every tool that isn't an explicit choice. A replacement `bash` from another extension is hidden too: wraps apply after every extension's tools are composed.
- **Model-only and deferred tools stay unchanged.** Hiding a tool that only the model may call (`callers: ["model"]`) would make it uncallable, and a deferred tool could no longer be loaded by `tool_search`, so Pit leaves both as they are.
- **The host can only narrow.** `AgentState.modelTools` filters the offered tools further, but can't offer a tool Pit hid; use `allowedTools` or `hideTools` instead. A host that removes `typescript` with `AgentState.tools` while keeping Pit selected leaves the model with no file or shell tools at all.
- **Pit owns the wrapped tools.** pi-durable names the last extension that provides or wraps a tool in its error reports, so a problem with `bash`, such as `invalid_structured_output`, names Pit.
- **Not a security boundary.** Hidden tools still run when another tool calls them, and Pit's own globals read files and run commands. Hiding changes what the model is offered, not what it can do.
- **Host effects move to Pit's process.** pi-durable's coding tools act in the host's `ExecutionEnv`; Pit's `workspace.*` and `shell.*` act in the process that runs the Harness. On a host whose environment is a container or remote machine, offer the coding tools with `allowedTools` or `hideTools: false`.

Existing conversations keep their history: earlier calls to a tool that is no longer offered stay in the transcript, and the next request offers the new tool set.

Results are plain text for the model plus the same JSON `details` Pi's renderers read: the value, progress, traces, timings, and saved-function changes. Command output streams through `output()` while a call runs. A failed call returns an error result whose text is the root error, as on Pi.

The `typescript` tool also carries a `present` field for hosts that show tool calls in a log, such as [pi-action's workflow log](https://github.com/cv/pi-action/blob/main/docs/extensions.md#show-tool-calls-in-the-workflow-log). pi-durable ignores it. `present.call(args)` gives the call's title, the label from the `// @pit:` header or the `label` argument (else the program's first line, the `functionId`, or `typescript`), and a body: the program without the header, then `params` as JSON, `functionId`, and `saveOnly`. `present.result(args, result)` gives a summary, the functions the program injected such as `workspace.read · git.status` (`saved <name>` for `saveOnly`, `asked: <title>` for a question, the error's first line on failure), and a body: the returned value with string fields as they are and other values as indented JSON, or the error. Both accept any stored arguments and results, including results pi-durable wrote itself without Pit's details.

## What doesn't

These throw a `PitDurableUnavailableError` whose message names the global, such as `commands.list is unavailable on pi-durable hosts: the host has no slash commands`:

- `session.getName`, `session.setName`, and `session.compact`: conversations have no name, and the host compacts them.
- `commands.*`: pi-durable has no slash commands.
- `models.set`: the host configures the conversation's model.
- Model requests (`models.listOfType`, `models.classify`, `models.generateImages`).

Pi-only features are absent: renderers and the `/functions` and `/pit-reflect` commands, Pit's skills, and catalog cache holding (pi-durable sends a changed section as a transcript delta).

## Questions

A program asks a person through `ui.confirm`, `ui.select`, and `ui.input`, and Pit asks before `functions.promote` and project function removal. How the answer arrives depends on the host's `ui` option.

**Asynchronous hosts** implement `ask(question)`. A GitHub thread is one: people may answer hours later, so nothing waits on a timer, and no program is replayed.

1. Pit derives the question's key: the first 16 hex characters of `sha256(JSON.stringify([kind, title, detail]))`, where `detail` is the confirm message, the select options array, or the input placeholder (`null` without one).
2. If the conversation has an unused answer with that key, the call returns it. An answer is an entry of kind `ui.answer` with data `{ key, kind, answer, by?, url? }`: `answer` is a boolean for confirm and a string for select and input. pi-action writes it as the user message that delivers the answer. An answer of the wrong type is skipped.
3. Otherwise Pit calls `ask({ kind, key, title, message | options | placeholder })`, which posts the question and returns at once with `{ url? }`. Pit stops the program, so it cannot catch the question and carry on, and returns a result that is not an error: `Question posted: <title> (<url>). The answer will arrive as a later message; end your turn now.` The result sets `control: { terminate: true }`, so the run ends after this tool round. Calls the program completed before asking keep their effects, and `runtime.completedCalls` recovers their results. Staged context edits and saved-function changes of the stopped program are dropped, as for any program that does not finish.
4. When the answer arrives, the model runs the step again, and the same question returns the answer.

An answer is used once. Pit records each answer a call used as a `ui.answer-consumed` entry with data `{ key }`, but only if the call succeeds: a program that fails after reading an answer gets the same answer when it runs again. After a successful call used it, the same question is asked anew.

**Interactive hosts** implement blocking `confirm`, `select`, and `input`, which Pit uses only when `ask` is absent. While one waits for its answer, the program's `timeoutMs` deadline is paused; other host calls running meanwhile still count. On Pi the deadline does not pause.

`notify` works the same way on both kinds of host. `context.get().hasUI` is `true` when the host implements `ask` or any blocking dialog.

## Session functions

A saved session function is written to the conversation as a data-only entry of kind `pit-function-definitions`, with the same data as Pi's custom entry: `{ name, source }`, or `{ name, deleted: true }` for a removal. pi-durable appends data-only writes at once, even during a run, and the call waits for them before it reports the change.

The first call in a conversation, per host process, replays these entries from the conversation's whole fork-aware history, so a reopened Harness and a fork see what earlier calls saved, and a fork's later changes stay in the fork. Conversations stay in memory up to a bound, least recently used first out; an evicted conversation replays again on its next call.

## Context editing and notes

`session.*` reads the conversation's active context, from the newest compaction head through the tail, and rewrites it with pi-durable's context edits: an entry whose `edits` omit or replace earlier entries' model messages. Entry IDs are pi-durable's entry numbers, as strings. Entries stay append-only: `session.inspectEntry` still reads an edited entry's original.

- **`elide(ids)`** replaces a tool result with a stub that names its size and how to read the original, keeping the call answered. An assistant entry's tool calls become one plain-text note, and their results leave the context with them, so the model sees neither a call to copy nor an unanswered one. User messages, compaction summaries, host messages, and the turn running the call are protected.
- **`summarize({ from, to, summary })`** replaces a contiguous range: its first entry carries the summary and the rest are omitted. A range must keep each tool call with its result, and the summary must be shorter than what it replaces.
- **`setNote(key, content)`** keeps notes in a conversation document, rendered as the `pit_notes` prompt section. Notes need no compaction hook: pi-durable sends sections again after a compaction head, so notes outlive compaction without depending on its summary, and a fork starts with the notes its parent had at the fork point. Each change sends the whole section again, so notes have Pi's budget (the larger of 4,096 tokens and 10% of the context window) and at most 32 keys.

When edits apply, as on Pi:

- **Only after the call succeeds.** `elide`, `summarize`, and `setNote` stage their change in the running `typescript` call; the call writes it after the program and its saved-function changes succeed, and a failed call drops it. A target can be staged once: a second elide of a staged entry fails until the first applies.
- **`when: "end"`, the default for `elide` and `summarize`:** when the run answers. The call writes the edit as a data-only entry, which changes nothing the model sees; an `afterRun` hook applies what the run staged in one write before the next input. A run that fails or is aborted drops its staged edits.
- **`when: "now"`:** after the current tool round. pi-durable places a write with `edits` at the next boundary, so the run's next request sees it.
- **`setNote`:** after the current tool round, like `when: "now"`: the next request renders the notes section again. `notes()` shows a change the running call staged as `pending: true`.

| Receipt `appliesAt` | Meaning                                                    |
| ------------------- | ---------------------------------------------------------- |
| `turn_end`          | Applies after the current tool round, if the call succeeds |
| `run_end`           | Applies when the run answers, if the call succeeds         |

Receipts report `appliesAt` (`turn_end` or `run_end`), the estimated tokens freed, and `cacheMode: "unknown"`: pi-durable does not report the provider's cache, so the re-prefill estimate assumes the whole conversation is sent again.

What the prototype established (pi-durable 1.5): replacing an assistant tool-call entry with text while omitting its result keeps the context valid; omitting only a result makes pi-durable answer the call with a placeholder ("Tool result unavailable"), and omitting only a call drops its now-orphaned result. Pit always edits a call and its results together. A replaced call can leave two or more assistant messages in a row. Anthropic's Messages API, through the NVIDIA route pi-action uses, accepts that, also when each message keeps its signed thinking block; see below.

### Collapsing finished runs

A durable conversation, such as a pi-action thread, keeps every tool call and result until pi-durable's threshold compaction runs, and each follow-up sends the whole thread again, usually on a cold prompt cache. So after every run that answers, Pit collapses the tool calls of older finished runs to one line each:

```
[Pit: collapsed typescript call · "Read npm and git global and command sources" · workspace.read, workspace.search · ok · ~18.2K tokens · originals: session.inspectEntry("212"), session.inspectEntry("213")]
```

- **The line** names the call's label (the `// @pit:` header or `label` argument, else the program's first line), the functions it injected, its outcome (`ok`, `failed: <error's first line>`, `asked: <title>`, or `saved <name>`), its size, and the `session.inspectEntry` IDs of the call and every result. Other tools show their name and outcome. An entry with several calls lists each, separated by `;`. A line takes at most 512 bytes: labels and outcomes are cut to 160 characters each, then the injected functions go, then the description is cut at its end. The size and IDs are never cut; IDs switch to the shorter `session.inspectEntry(id) for "212", "213"` when the usual form does not fit.
- **What collapses:** assistant tool calls and their results, the pairing `elide` uses. The assistant entry keeps its text and thinking, signatures included; its calls become the line and its results are omitted, so no call is left unanswered. User and host messages, answers, compaction summaries, notes, entries already rewritten or staged for a rewrite, and entries no larger than their line stay as they are. A model's own `elide` or `summarize` wins: the collapse skips its targets.
- **When:** in the same `afterRun` write that applies the edits the run staged, so one `pit.context-edit` entry carries both; collapses are recorded as `operation: "collapse"`, and `session.outline()` shows collapsed entries as `elided` with the line as their preview. A failed or aborted run collapses nothing. A run that ended on a `terminate` round, such as a posted question, counts as finished.
- **Which runs:** a run starts at the user or host messages after the previous run's entries. The newest `keepRuns` runs (default 1, the run that just answered) stay whole, since a follow-up usually refers to the run before it. The collapse reads only the active context, so it never crosses the newest compaction head, and a fork keeps the view it had at its fork point.
- **`minTokens`** (default 32,000) counts the conversation's messages, not the system prompt, tools, and sections. Below it the transcript costs less than Pit's fixed prompt on pi-action (about 41K tokens), so collapsing saves little and short threads stay verbatim.
- **The model is told.** With collapse on, the `pit_guidelines` section adds: "Calls from finished runs collapse to their labels: give each call a specific label, and say in your answer what a later run will need." Collapsed lines are only as good as their labels, and the run's answer is what a later run reads first.

Pit checked the collapsed shape against Opus 5.5 through Anthropic's Messages API on NVIDIA's endpoint: a user message, two collapsed tool-calling turns each keeping its own signed thinking block, the answer, and a follow-up were accepted, and with the guideline in the prompt the model read the lines as its own earlier calls. Without the guideline it once took a collapsed line for text it had written instead of a call. Sending the same signed thinking block twice was refused as duplicating model output; collapsing never copies a block, since each entry keeps its own.

## Security notes

Read the [security model](security.md) first; everything there applies. On pi-durable, also:

- **Host effects run in the host process.** Pit's globals read and write files and run commands with Node in the process that runs the Harness, with that process's user, environment, and network access. They do not go through pi-durable's `ExecutionEnv`: a host that gives the agent a container or remote environment does not confine Pit. Run such hosts with Pit only where host-process effects are acceptable.
- **Treat prompts as code.** Whoever can write to the conversation, for example by commenting on an issue that pi-action answers, can ask the model to run commands. Limit who can drive the conversation, and keep secrets the job does not need out of the host's environment.
- **Project trust is off by default.** An untrusted project's `.pi/functions` and `.pi/pit.json` do not load, and programs cannot save project functions. Pull-request checkouts in particular should stay untrusted.
- **Project function files ask first.** On pi-durable, `functions.promote` to the project and `functions.remove` of a project function ask through the host's `ui` before they write or delete `.pi/functions`, even in a trusted project; Pi asks only for user-scope changes. Programs in a trusted project can still write any project file with `workspace.edit`, so this guards the saved-function workflow, not the repository.
- **Promoted files live in the working tree.** A project promotion writes `.pi/functions/<name>.ts` in the host's checkout and the function leaves the session. A host that checks the repository out fresh for each run, as CI runners do, loses it unless a program commits and pushes the file; the promotion's result says so.
- **No dialogs, no confirmation.** Without `ui`, every operation that asks (user-scope promotion and removal, and project function promotion and removal) fails instead of proceeding.
