# Architecture

This document describes Pit's implementation as of v0.15.1. It is a maintainer's map of the current runtime, not a promise that every internal interface is stable. User-facing behavior belongs in the [README](../README.md); release procedure belongs in [releasing.md](releasing.md).

Pit presents one `typescript` tool to the model. Submitted TypeScript is formatted and type-checked in the trusted extension host, compiled into a self-contained program, and evaluated in a fresh permission-restricted Node process. The child has no useful ambient authority. It requests effects from the host through typed capabilities such as `workspace`, `git`, `npm`, `gh`, `shell`, and `http`.

## System model

```text
Pi extension host
│
├─ src/index.ts                         composition root
│  ├─ FunctionState                    in-memory global/project/session registries
│  ├─ SavedFunctionService             preparation, promotion, persistence, removal
│  ├─ saved-function lifecycle         Pi events, prompt catalogs, /functions
│  └─ TypeScript tool adapter          request orchestration and rendering
│
├─ trusted preparation path
│  ├─ Oxfmt source canonicalization
│  ├─ TypeScript semantic validation
│  ├─ saved-function dependency and scope resolution
│  └─ esbuild compilation
│
├─ fresh restricted Node child
│  └─ compiled submission + capability proxies
│          │
│          └─ authenticated newline-delimited JSON RPC
│
└─ trusted capability dispatcher
   ├─ workspace and process adapters
   ├─ Pi session, command, model, runtime, and UI adapters
   ├─ saved-function management
   └─ bounded HTTP requests
```

There are three distinct authority layers:

1. **Pi and the Pit extension host are trusted.** They hold the extension context, saved-function state, filesystem access, process execution, network access, and UI handles.
2. **Each submitted program runs in an untrusted child.** Node's permission model prevents direct filesystem, network, subprocess, worker, addon, and inherited-environment access.
3. **Capabilities deliberately reintroduce selected host authority.** The sandbox is a boundary around direct access, not around effects explicitly exposed by a capability. Validation and bounds are therefore part of each host capability's contract.

Pit has no long-lived code worker or daemon. A new child is created for each TypeScript invocation; only extension-host state and persisted function definitions survive between calls.

## Extension composition and Pi lifecycle

`src/index.ts` is the composition root. Loading the extension:

1. creates one mutable `FunctionState` for the loaded extension instance;
2. creates a promise-tail commit queue that serializes saved-function mutations, including failed mutations;
3. creates `SavedFunctionService`, which owns coordinated state and persistence changes;
4. registers saved-function lifecycle handlers and the `/functions` manager; and
5. registers the `typescript` tool and its renderers.

The function state is intentionally explicit rather than hidden in module globals. The commit queue protects multi-step operations such as validate-write-reconcile from racing when tool calls or UI actions overlap.

### `session_start`

On session start, `src/functions/lifecycle.ts`:

1. clears in-memory usage counts and promotion suggestions;
2. loads global and project configuration in parallel;
3. enables global definitions only when user configuration allows them and the project has not opted out;
4. enables project definitions only for a trusted project with `.pi/pit.json` opt-in;
5. loads and validates persistent candidates;
6. reconstructs session definitions from the active Pi branch's custom entries;
7. reconciles scope precedence and dependency closure;
8. reports a bounded set of loading errors through the UI; and
9. sets `typescript` as the active tool.

### `session_tree`

When branch navigation changes the active session tree, Pit reconstructs session functions from that branch's entries, resets usage suggestions, and reconciles the effective registry again. Session functions therefore follow Pi's branch history instead of behaving as process-global mutable state.

### `before_agent_start`

Before an agent turn starts, Pit augments the system prompt with:

- discovered skills when the incoming Pi prompt does not already contain them;
- global function signatures, summaries, and parameter descriptions; and
- project function signatures, summaries, and parameter descriptions.

Persistent function source is not copied into the prompt. Session overrides are identified as overrides, and the full source closure is injected only during compilation when submitted code references a saved function.

## TypeScript invocation lifecycle

`src/tool/typescript.ts` is the application adapter between Pi's tool API and Pit's internal services. A normal invocation follows this order:

1. **Canonicalize source.** Pit asks Oxfmt to format the completed submission with a fixed configuration. Formatting is best-effort: formatter failure does not replace the more useful validation path.
2. **Prepare candidate state.** `SavedFunctionService.prepare()` classifies the source as anonymous or as a named top-level function. A named direct submission is always prepared as a session definition. Project or global persistence requires an explicit promotion path.
3. **Validate the candidate registry.** The new definition is evaluated against the registry that would exist after a successful commit. This makes the definition available to its own first execution without mutating live state prematurely.
4. **Compile and execute.** Pit resolves reachable saved functions, generates scope-aware wrappers, compiles the program, starts a child, and dispatches capability calls.
5. **Commit only after success.** A named direct submission is appended to Pi's session history and installed in memory only after execution succeeds. Failed definitions do not become active. With `saveOnly`, execution is skipped but the same validated commit path is used.
6. **Build a bounded result.** The model receives truncated text when needed, saved-function guidance, promotion suggestions, and a compact session catalog. Structured details retain traces, progress, and untruncated values only when safe to do so.

Anonymous expressions do not mutate function state. Top-level `params` are accepted only for function expressions and are supplied as the second argument to the submitted function. The public tool timeout defaults to 30 seconds and is bounded to 1–300,000 milliseconds.

The execution pipeline deliberately separates **prepare**, **run**, and **commit**. This is the main transactional invariant for session definitions: runtime failure cannot leave a partially installed function.

## Validation, dependency discovery, and compilation

### Semantic validation

`src/sandbox/validation.ts` creates an in-memory TypeScript program with three virtual files:

- the generated capability contract and allowed sandbox globals;
- declarations and source signatures for reachable saved functions; and
- the submitted program wrapper.

Validation uses strict ES2022 compiler settings without emitting JavaScript. Diagnostics are deduplicated, bounded, and rewritten to locations in the submitted source. The actual serialized `params` value is included in validation so obvious input-shape mismatches fail before a child starts.

Validation results use a bounded 128-entry cache keyed by source, effective function sources, available names, execution form, and input. Both successful and failed validations are cached.

### Dependency discovery

Saved-function references are not found with text matching. `src/functions/graph.ts` constructs a small TypeScript program, binds candidate names to compiler symbols, and records runtime identifier references. This avoids treating shadowed names and type-only references as dependencies.

The graph supports:

- direct and transitive dependency resolution;
- reverse dependent lookup for safe removal;
- strongly connected component detection for cycles; and
- bounded fingerprinted caches for registries and source references.

Only definitions reachable from the submitted source are compiled into a child program. The complete transitive closure is resolved with cycle-safe traversal; generated declarations and deferred wrappers allow mutually referential definitions to be assembled without depending on assignment order.

### Scope-aware runtime generation

`src/functions/scoped-runtime.ts` generates a separate runtime definition keyed by `scope:name`, not merely by name. That distinction preserves lexical scope rules when the same name exists in multiple registries:

| Calling definition | Definitions visible to its dependencies     |
| ------------------ | ------------------------------------------- |
| Global             | Global only                                 |
| Project            | Project, then global fallback               |
| Session            | Session, then project, then global fallback |

For example, a session override named `helper` does not silently alter what an already-persisted project function means when that project function calls `helper`. The project definition resolves dependencies in project scope. The submitted session program can still resolve the session override as its own root binding.

Generated wrappers also attach function name, scope, parent invocation, and depth to capability calls. Saved-function failures are wrapped with the function name while retaining the original cause.

### Compilation

After validation and scope resolution, esbuild transforms the generated TypeScript expression to ES2022 JavaScript with an inline source map. Compilation has a separate bounded 128-entry cache. Validation, compilation, and dependency caches can be cleared together for tests and diagnostics.

## Sandbox and RPC boundary

`src/sandbox/run.ts` launches `src/sandbox/runner.mjs` with Node's permission model enabled. The child can read only the runner file, receives only `PATH` in its environment, and has a default 128 MB old-space limit. The runner has no project or third-party imports.

The compiled source is evaluated indirectly so it cannot capture the runner module's lexical RPC state. Its apparent capabilities are nested proxies. Calling `workspace.read(...)`, for example, emits a wire request instead of touching the filesystem in the child.

Parent and child communicate with token-authenticated, newline-delimited JSON frames over standard input and output. A random token is generated per invocation. Frames with the wrong token are ignored, malformed output is ignored, and oversized frames fail the invocation. Child `console` output is redirected to standard error so diagnostics cannot corrupt the protocol stream.

Current defensive bounds are:

| Resource                        | Effective host limit |
| ------------------------------- | -------------------: |
| Wire frame                      |      8,000,000 bytes |
| Capability calls per invocation |                1,024 |
| Concurrent capability calls     |                   32 |
| Saved-function nesting depth    |                   32 |
| Default TypeScript wall time    |           30 seconds |
| Default child old-space limit   |               128 MB |

The child has looser duplicate call limits as defense in depth; the host limits above are authoritative. On result or failure, both sides wait for already-started capability calls to settle before finalizing. Cancellation and timeout abort the signal shared by host capability handlers and then terminate the child. `SandboxLifecycle` uses `SIGKILL` for deterministic child cleanup.

Remote failures cross the wire as bounded name, message, and stack-frame data. The host reconstructs a `SandboxRemoteError`; raw child objects and arbitrary prototypes never cross the boundary.

## Capability architecture

A capability has two halves.

### Definition layer

Files such as `src/capabilities/workspace.ts` and `src/capabilities/git.ts` declare:

- the TypeScript interface name;
- each method declaration;
- prompt documentation and call descriptions;
- minimum and maximum argument counts; and
- optional result-renderer keys.

`src/capabilities/registry.ts` assembles those definitions into `CAPABILITY_REGISTRY`. The same registry drives method existence checks and generation of `src/generated/capability-contract.d.ts`. A capability change should therefore begin in the definition layer rather than by editing generated declarations.

### Host layer

`src/capabilities/host.ts` creates a dispatcher for one invocation using Pi's current `ExtensionContext`, current function state, and the invocation's abort signal. It validates capability and method names plus argument counts, then delegates to domain handlers that validate concrete argument shapes.

Capabilities fall into three implementation groups:

- **Host effects:** workspace, process, Git, npm, GitHub CLI, and HTTP operations.
- **Pi adapters:** UI, session, slash-command, model, runtime, and context operations.
- **Function control:** listing, inspection, promotion, removal, and internal saved-function run attribution.

Typed Git, npm, and GitHub methods construct argument arrays and run without a shell. `shell.execFile` is the general argument-safe escape hatch; `shell.exec` explicitly invokes `/bin/sh -lc` when shell syntax is required. The distinction is behavioral, not cosmetic.

The internal `__pit.savedFunctionRun` method is generated into wrappers but is not part of the model-facing contract. It records activity and drives bounded promotion suggestions after repeated session-function use.

### Generated contract

Run:

```sh
npm run capabilities:generate
```

This writes `src/generated/capability-contract.d.ts`. `npm run capabilities:check` regenerates in memory and fails when the checked-in artifact is stale. Never edit the generated file manually.

## Saved-function state and persistence

### Registries and precedence

`FunctionState` holds distinct registries:

- `global`: validated user-global definitions;
- `projectCandidates`: all validated project files before per-session reconciliation;
- `project`: project definitions active for the current session closure;
- `session`: definitions reconstructed from the current Pi branch; and
- `effective`: the merged view used by submitted code.

Effective precedence is:

```text
session overrides project overrides global
```

Metadata has parallel global, project-candidate, and active-project registries. Source and prompt metadata are separate because runtime injection needs complete source while prompts need only bounded signatures and summaries.

`projectCandidates` and active `project` are intentionally different. Reconciliation selects dependency closures that fit the effective registry and respect session overrides. Invalid or over-capacity definitions can be excluded without losing knowledge that their files exist.

### Storage and enablement

| Scope                | Source of truth                                  | Enablement                                         |
| -------------------- | ------------------------------------------------ | -------------------------------------------------- |
| Session              | Pi custom branch entries of type `pit-functions` | Available for the loaded session                   |
| Project              | `.pi/functions/<name>.ts`                        | Trusted project and `.pi/pit.json` opt-in          |
| Project, legacy read | `.pi/pit/functions/<name>.ts`                    | Same as project                                    |
| Global               | `~/.pi/agent/pit/functions/<name>.ts`            | `~/.pi/agent/pit.json` opt-in; project may opt out |

Storage location determines persistent scope. `@pit project` and `@pit global` source markers have no runtime meaning.

When both project paths contain the same filename, `.pi/functions/` wins even if the winning file later fails validation; the legacy copy does not resurface under that name. Saving a project function writes the current path and removes its same-name legacy file. Removing a project function clears both paths.

Persistent files must contain one documented top-level function declaration whose name matches the filename. Loading proceeds in deterministic filename order. Each candidate is validated with its reachable dependencies, then the complete registry is repeatedly validated so functions with invalid dependencies are removed as well.

Writes use a per-path mutation queue, a temporary file, and rename. In-memory registries are updated only after the filesystem operation succeeds. Project and global state mutations additionally pass through the extension-level function commit queue.

### Session history

Setting a session function appends its complete source to Pi's session history. Removal or promotion appends a deletion tombstone. Reconstruction replays entries in branch order and ignores malformed, stale, or over-capacity entries. This event-log design makes branch navigation deterministic and avoids storing session definitions in separate files.

### Promotion and removal

Promotion is explicit:

- project promotion requires a trusted, enabled project;
- global promotion requires global enablement and rejects dependencies that are not already global;
- promotion writes the persistent file, appends a session tombstone, removes the session override, and reconciles effective state; and
- promotion creates ordinary marker-free TypeScript with a normalized documentation summary.

Removal is dependency-aware. Planning computes direct and transitive dependents before mutation. Persistent removal is blocked while saved dependents remain. Session removal requires an explicit cascade when dependent session definitions would also be removed. The `/functions` UI adds confirmation around persistent and global mutations.

Current saved-function capacity bounds are 64 effective definitions, 100,000 bytes per source, and 1,000,000 bytes of combined source. Prompt catalogs are separately bounded so a valid registry cannot consume an unbounded system prompt.

## Workspace consistency model

Workspace effects execute in the trusted host. Paths are resolved against Pi's current working directory; an absolute path remains absolute. The workspace capability is therefore not a repository-containment sandbox. Its safety model is the restricted child plus explicit host capability surface, optimistic edit checks, bounded output, and the agent's operating policy.

Hashed reads return:

- a whole-file revision derived from the contents; and
- `line:hash` anchors derived from each line's content.

An edit must present the current revision. Anchored changes must also match their target lines. This catches both whole-file races and stale line locations while allowing multiple non-overlapping changes from one snapshot. A successful mutation produces a new revision, invalidating old edit coordinates.

Per-file mutations use Pi's file mutation queue. A multi-file edit batch:

1. rejects duplicate targets and mixed read/edit operations;
2. acquires target queues in sorted order to avoid queue-order deadlocks;
3. snapshots and prepares every edit before writing;
4. commits files sequentially; and
5. attempts rollback of already-written files if a later write fails.

Rollback is best-effort because filesystem failures can also affect recovery. Batch reads run concurrently and may use fail-fast or settled result semantics.

## Process execution

`src/process/runner.ts` normalizes process options, resolves the working directory, applies output bounds, and chooses the host execution path.

- Calls without progress use Pi's `pi.exec`.
- Calls with live progress use Pit's streaming child-process host.
- Typed capabilities construct argument arrays and spawn without a shell.
- `shell.exec` is the only general path that intentionally asks a shell to parse a command string.

Process calls default to a 120-second timeout and bounded head or tail output. `raise: true` converts nonzero exits into bounded exceptions; otherwise exit status is data. Streaming cancellation first sends `SIGTERM`, escalates to `SIGKILL` after five seconds, maps timeout to code 124, and maps abort to code 130. A short post-exit grace handles descendants that inherited output pipes without allowing the tool to hang indefinitely.

## Progress, traces, results, and rendering

Execution observability is structured before it is rendered.

- `CapabilityDispatcher` emits start and finish traces with capability name, method, timing, status, argument types and sizes, and optional saved-function context. It does not retain argument values.
- `CapabilityTraceCollector` keeps at most 128 traces and marks truncation.
- `ExecutionProgressController` tracks shell output tails and completed status, sanitizes terminal control text, keeps at most 32 completed shell calls, and throttles Pi partial updates to at most one burst update every 200 ms.
- Capability trace reporting is observational: dispatcher-side listener failures are caught and cannot change capability execution.

The TypeScript tool returns two views:

1. bounded text content for the model; and
2. structured details for Pit's renderers and Pi's expanded result view.

`src/renderers/` turns those details into partial and final TUI components. Renderers do not own execution state or perform effects. Failure enrichment similarly consumes captured execution context after failure rather than changing the underlying error path.

## Source layout

Pit is organized around feature boundaries:

- `src/capabilities/` defines the model-facing contract, registry, host composition, command preparation, and Pi control handlers.
- `src/functions/` owns session, project, and user-global saved functions, including state, persistence, dependency analysis, promotion, removal, and scoped runtime generation.
- `src/sandbox/` owns validation, compilation, wire protocol, process lifecycle, dispatch, and restricted execution.
- `src/tool/` is the application adapter for TypeScript tool orchestration, rendering, source formatting, timing, metadata, and failure context.
- `src/process/` owns host-process execution, bounded process results, and process-runner behavior.
- `src/workspace/` owns workspace paths, hashed reads and edits, search, and regex worker behavior.
- `src/execution/` owns progress snapshots, capability traces, and dashboard models.
- `src/renderers/` contains TUI and result presentation. Only renderer modules, the tool adapter, and root composition may depend on them.
- `src/shared/` contains neutral helpers safe for lower-level domains.
- `src/generated/` contains generated artifacts and must not be edited manually.

Files directly under `src/` are composition entry points or true cross-domain adapters. Do not add a general-purpose `utils.ts`; place helpers in the domain that owns their semantics or in `src/shared/` when they are intentionally neutral.

## Dependency rules

- Internal modules import concrete leaf modules rather than broad barrel or compatibility-facade files.
- Saved-function primitives may use `src/sandbox/validation.ts`, but must not import sandbox execution or compilation entry points.
- Sandbox validation may parse saved-function source, but must not depend on saved-function state or persistence.
- Only `src/tool/`, root composition, and renderer modules may import TUI renderer modules.
- Capability registry and host modules are expected composition roots with high fan-out.
- Internal source imports must remain acyclic.

`npm run structure:check` enforces an acyclic source graph, limits authored files directly under `src/`, rejects saved-function imports through sandbox execution facades, validates renderer dependency direction, and verifies generated-contract placement. It is part of `npm run check`.

## Where to make a change

| Change                              | Start here                                       | Usually also inspect                                             |
| ----------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------- |
| Add or change a capability          | `src/capabilities/<name>.ts`                     | `registry.ts`, `host.ts`, handlers, generated contract, renderer |
| Change TypeScript request semantics | `src/tool/typescript.ts`                         | preparation, sandbox run, result renderers                       |
| Change validation or compilation    | `src/sandbox/validation.ts` or `program.ts`      | generated contract, function graph, scoped runtime               |
| Change child isolation or RPC       | `src/sandbox/run.ts` and `runner.mjs`            | lifecycle, wire, dispatcher, security tests                      |
| Change saved-function scope         | `src/functions/state.ts` and `scoped-runtime.ts` | preparation, reconciliation, graph, removal                      |
| Change persistent storage           | `src/functions/storage/`                         | lifecycle, service, project integration tests                    |
| Change workspace edits              | `src/workspace/hashline.ts` and `capability.ts`  | read/search, concurrency tests                                   |
| Change process behavior             | `src/process/`                                   | capability host, progress, process renderer                      |
| Change partial/final presentation   | `src/execution/` and `src/renderers/`            | tool adapter and extension smoke tests                           |

## Tests and architecture gates

Tests are grouped by behavior under `test/`, mirroring source domains where useful:

- `test/capabilities/`
- `test/execution/`
- `test/extension/`
- `test/functions/`
- `test/process/`
- `test/renderers/`
- `test/sandbox/`
- `test/shared/`
- `test/tool/`
- `test/workspace/`

Shared extension harnesses live in `test/support/`. Split suites by behavior rather than requiring one test file per source file.

The standard static gate runs generated-contract drift detection, architecture checks, TypeScript, Oxlint, and Oxfmt. The test and coverage gates exercise host-child boundaries and the package verification gate checks the files distributed by the GitHub tag. Changes to TUI, extension lifecycle, saved-function loading, sandbox behavior, partial updates, or renderers also require a `/reload` smoke test because those boundaries depend on live Pi integration.
