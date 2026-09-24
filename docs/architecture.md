# Architecture

This document describes Pit 0.17.0's runtime. It is a maintainer's map, not a promise that every internal interface is stable. User-facing behavior belongs in the [README](../README.md); release procedure belongs in [releasing.md](releasing.md).

Pit presents one `typescript` tool to the model. Submitted TypeScript is formatted and type-checked in the trusted extension host, compiled into a self-contained program, and evaluated by QuickJS inside a fresh bounded Wasmtime store. The Wasm component has no useful ambient authority. It requests effects from the host through explicitly injected functions such as `workspace.read`, `git.status`, and `http.request`.

## System model

```text
Pi extension host
│
├─ src/index.ts                         composition root
│  ├─ FunctionState                    persistent/session source state
│  ├─ SavedFunctionService             preparation, promotion, persistence, removal
│  ├─ saved-function lifecycle         Pi events, prompt catalogs, /functions
│  ├─ configured FunctionExecutor      Wasmtime default; Node fallback
│  └─ TypeScript tool adapter          request orchestration and rendering
│
├─ trusted preparation path
│  ├─ Oxfmt source canonicalization
│  ├─ TypeScript semantic validation
│  ├─ layered function graph and grant resolution
│  └─ esbuild compilation
│
├─ in-process native boundary
│  ├─ fresh Wasmtime store + restricted WASI context
│  └─ custom QuickJS component + queued JSON requests
│          │
│          └─ bounded concurrent host callbacks
│
└─ trusted capability dispatcher
   ├─ exact resolved effect grant
   ├─ workspace and process adapters
   ├─ Pi session, command, model, runtime, and UI adapters
   ├─ function management and attribution
   └─ bounded HTTP requests
```

There are three distinct authority layers:

1. **Pi and the Pit extension host are trusted.** They hold the extension context, function state, filesystem access, process execution, network access, and UI handles.
2. **Each submitted program runs in an untrusted Wasm guest.** Its restricted WASI context inherits no filesystem, environment, network, arguments, or stdio. Fuel, epoch deadlines, store limits, and protocol limits bound each invocation.
3. **Injected functions deliberately reintroduce selected host authority.** The sandbox is a boundary around direct access, not around effects explicitly exposed by a function. The host enforces the exact resolved transitive effect grant.

Pit has no long-lived code worker or daemon. Each TypeScript invocation creates a new Wasmtime engine, store, and QuickJS runtime; only extension-host state, the loaded component bytes, and persisted function definitions survive between calls.

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
2. loads user functions automatically from the active Pi agent directory;
3. makes package-owned global definitions available independently of persistent configuration;
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
- user function signatures, summaries, and parameter descriptions; and
- project function signatures, summaries, and parameter descriptions.

Persistent function source is not copied into the prompt. Session overrides are identified as overrides, and the full source closure is injected only during compilation when submitted code references a saved function.

## TypeScript invocation lifecycle

`src/tool/typescript.ts` is the application adapter between Pi's tool API and Pit's internal services. A normal invocation follows this order:

1. **Canonicalize source.** Pit asks Oxfmt to format the completed submission with a fixed configuration. Formatting is best-effort: formatter failure does not replace the more useful validation path.
2. **Prepare candidate state.** `SavedFunctionService.prepare()` classifies the source as anonymous or as a named top-level function. A named direct submission is always prepared as a session definition. Project or user persistence requires an explicit promotion path.
3. **Validate the candidate registry.** The new definition is evaluated against the registry that would exist after a successful commit. This makes the definition available to its own first execution without mutating live state prematurely.
4. **Compile and execute.** Pit resolves reachable saved functions, generates scope-aware wrappers, compiles the program, starts a fresh Wasmtime store, and dispatches capability calls.
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

Validation uses strict ES2022 compiler settings without emitting JavaScript. Diagnostics are deduplicated, bounded, and rewritten to locations in the submitted source. The actual serialized `params` value is included in validation so obvious input-shape mismatches fail before guest execution starts.

The authoring contract exposes portable language globals, bounded `setTimeout`, and `console.log/warn/error`, but not Node's `process`, `require`, or `Buffer`. The Wasmtime wrapper installs no-op console methods rather than entering Javy's WASI-backed stdio from the addon's asynchronous runtime. Visible diagnostics must be returned as data.

Validation results use a bounded 128-entry cache keyed by source, effective function sources, available names, execution form, and input. Both successful and failed validations are cached.

### Dependency discovery

Saved-function references are not found with text matching. `src/functions/graph.ts` constructs a small TypeScript program, binds candidate names to compiler symbols, and records runtime identifier references. This avoids treating shadowed names and type-only references as dependencies.

The graph supports:

- direct and transitive dependency resolution;
- reverse dependent lookup for safe removal;
- strongly connected component detection for cycles; and
- bounded fingerprinted caches for registries and source references.

Only definitions reachable from the submitted source are compiled into a guest program. The complete transitive closure is resolved with cycle-safe traversal; generated declarations and deferred wrappers allow mutually referential definitions to be assembled without depending on assignment order.

### Layered runtime generation

`src/functions/unified-runtime.ts` generates wrappers for concrete resolved definitions. Explicit dependencies resolve virtually against session, project, user, and package-owned global definitions. This replaces the former scope-pinned lexical runtime; multi-function dependency cycles are rejected.

Only direct declared dependencies are injected. The trusted host grants the resolved transitive private-effect closure. Generated wrappers attach function identity and scope to host calls; trace scope uses `user` directly without translation to the old `global` name.

### Compilation

After validation and scope resolution, esbuild transforms the generated TypeScript expression to ES2022 JavaScript with an inline source map. Compilation has a separate bounded 128-entry cache. Validation, compilation, and dependency caches can be cleared together for tests and diagnostics.

## Sandbox and RPC boundary

`scripts/install-wasmtime.mjs` selects the current OS and architecture during Pi's Git package `npm install`, downloads only that release addon plus the shared QuickJS component, verifies both against the release checksum manifest, and writes them atomically under `native/prebuilds/<target>/`. `src/sandbox/wasmtime-loader.ts` loads those artifacts by default. Missing implicit artifacts warn and fall back to the deprecated Node child; explicit Wasmtime configuration remains strict. `PIT_FUNCTION_EXECUTOR=node` selects Node deliberately, while `PIT_WASMTIME_ADDON` and `PIT_WASMTIME_COMPONENT` can replace both installed artifacts together.

`src/sandbox/wasmtime-executor.ts` gives every invocation a random execution ID and creates a bounded dispatcher for the program's resolved effects. It wraps the compiled program as an ES module that exposes a queued `pitCall()` bridge. The custom component retains JavaScript Promise resolvers, exports queued requests to Rust, accepts completions, and pumps pending QuickJS jobs.

The Rust N-API addon creates a fresh Wasmtime engine, store, restricted WASI Preview 2 context, and QuickJS runtime for each invocation. Independent request callbacks in one queue batch are awaited concurrently. Requests and responses are JSON strings bounded on both sides; they never use process stdio. The host dispatcher validates every call against the resolved grant before invoking a capability handler.

Current defensive bounds are:

| Resource                        |  Effective host limit |
| ------------------------------- | --------------------: |
| Protocol frame                  |       8,000,000 bytes |
| Capability calls per invocation |                 1,024 |
| Concurrent capability calls     |                    32 |
| Saved-function nesting depth    |                    32 |
| Default TypeScript wall time    |            30 seconds |
| Default Wasmtime memory limit   |                128 MB |
| Default Wasmtime fuel           | 9,007,199,254,740,991 |

Timeouts and explicit cancellation advance the execution epoch. Cancellation IDs are registered race-safely: an abort arriving before native registration is queued and interrupts initialization once the epoch timer is installed. The same abort signal reaches cooperative host capability handlers. Each execution registration, epoch timer, store, and QuickJS runtime is discarded when the call settles.

Wasmtime links the WASI interfaces required by Javy, but `WasiCtx::builder().build()` inherits nothing. The guest cannot directly read files, access environment credentials, open network connections, or launch processes. Wasmtime itself is a native addon inside Pi's process, so a native runtime defect shares the trusted host's crash boundary.

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

`FunctionState` holds user source, trusted project candidates, active project source, branch-local session source, and the effective source view. Pit's native-backed globals come from `globalFunctionDefinitions()` and are not user-owned storage. Compilation resolves `session > project > user > global`.

Invalid user and project definitions are retained separately by identifier. Preparation checks reachable explicit dependencies against these diagnostics, preventing silent fallback through an invalid persisted override. Unrelated functions remain usable. Source quotas apply to authored functions, not native built-ins.

### Storage and enablement

| Scope   | Source of truth                              | Enablement                                            |
| ------- | -------------------------------------------- | ----------------------------------------------------- |
| Global  | Package-owned definitions                    | Always                                                |
| User    | `${PI_CODING_AGENT_DIR}/functions/`          | Automatic                                             |
| Project | `.pi/functions/`                             | Trusted project and `projectFunctions.enabled` opt-in |
| Session | Pi `pit-function-definitions` branch entries | Active branch                                         |

The default user directory is `~/.pi/agent/functions/`; Pi's `getAgentDir()` determines it. The old user `pit.json` enablement configuration is no longer read. Legacy user/project function directories and `pit-functions` session entries are ignored, never migrated or deleted.

Persistent identifiers come from canonical relative file paths: `company/check.ts` declares `check` and defines `company.check`. Each file contains one documented top-level function declaration. Dotted filenames, case-only collisions, reserved filesystem names, namespace collisions, and declaration mismatches are rejected. Discovery visits at most 2,048 entries and reads at most 100,000 bytes per file, with a 4 MB aggregate source budget. Symlinked directories are not traversed; symlinked definition files are invalid. An absent directory is empty and is not created by loading.

Writes use a per-path mutation queue, a sibling temporary file, and rename. User/project mutation paths reject symlinks. External edits are picked up at session start or reload; there is no watcher. Other Pi processes reload independently—there is no cross-process registry transaction.

### Promotion and removal

New definitions begin in the session layer. Promotion targets only `project` or `user`; `global` is not a writable alias. User promotion requires confirmation and rejects project/session-only dependencies. Dependencies resolve virtually during invocation, including compatible higher-layer replacements of a portable dependency.

Persistence succeeds before session tombstones and live registry changes are committed. Atomic file replacement is not a transaction across filesystem storage and Pi's session journal. Removal is dependency-aware and targets only canonical files. Removing an invalid user definition also clears its unavailable-identifier diagnostic. Project access retains its trust and enablement checks; user access has no old global-enablement gate.

The management API names user operations `listUser`, `getUser`, and `removeUser`; the old `*Global` user-storage aliases are removed. `/functions` labels user-owned source as user scope. The `typescript` tool accepts `functionId` for named definitions; the leaf must match the declaration name. Session records, removal tombstones, catalogs, traces, and promotion use that full identifier. Preparation, replay, and commit reject namespace conflicts and overrides of sealed global functions. The type checker retains every concrete layer needed for the selected signatures, checks adjacent overrides after removing the implementation-only dependency parameter, and contextually types `$next` against the next lower definition. It checks argument assignability, required arity, and resolved return compatibility; generic signatures retain their declared type parameters. Named root execution receives the same next binding and attribution context as saved invocations. Promotion validates both the destination stack and the resulting active stack before writing. Removal checks affected definitions against the proposed fallback chain. Invalid persisted overrides stay unavailable, never silently exposing a lower implementation. `FunctionInspector` provides one snapshot for the API and manager: native globals and authored definitions share provenance, signatures, resolved dependencies, override chains, next targets, and effects. Listing is paginated and scope-filterable; invalid persisted entries remain inspectable as diagnostics. Native implementation handles are never exposed, and no source is fabricated for native definitions. Globals are read-only in both API mutation planning and UI actions. All `functions.*` global definitions are sealed; rejected override attempts remain visible without disabling those management functions.

## Workspace consistency model

Workspace effects execute in the trusted host. Paths are resolved against Pi's current working directory; an absolute path remains absolute. The workspace capability is therefore not a repository-containment sandbox. Its safety model is the restricted Wasm guest plus the explicit host function surface, optimistic edit checks, bounded output, and the agent's operating policy.

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
- `src/functions/` owns session, project, and user saved functions, including state, persistence, dependency analysis, promotion, removal, and scoped runtime generation.
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

| Change                              | Start here                                        | Usually also inspect                                             |
| ----------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------- |
| Add or change a capability          | `src/capabilities/<name>.ts`                      | `registry.ts`, `host.ts`, handlers, generated contract, renderer |
| Change TypeScript request semantics | `src/tool/typescript.ts`                          | preparation, sandbox run, result renderers                       |
| Change validation or compilation    | `src/sandbox/validation.ts` or `program.ts`       | generated contract, function graph, scoped runtime               |
| Change guest isolation or protocol  | `src/sandbox/wasmtime-executor.ts` and `native/`  | guest source, dispatcher, prebuilds, security tests              |
| Change saved-function scope         | `src/functions/state.ts` and `unified-runtime.ts` | preparation, reconciliation, graph, removal                      |
| Change persistent storage           | `src/functions/storage/`                          | lifecycle, service, project integration tests                    |
| Change workspace edits              | `src/workspace/hashline.ts` and `capability.ts`   | read/search, concurrency tests                                   |
| Change process behavior             | `src/process/`                                    | capability host, progress, process renderer                      |
| Change partial/final presentation   | `src/execution/` and `src/renderers/`             | tool adapter and extension smoke tests                           |

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

The standard static gate runs generated-contract drift detection, architecture checks, TypeScript, Oxlint, and Oxfmt. The test and coverage gates exercise host-guest boundaries and the package verification gate checks the files distributed by the GitHub tag. Changes to TUI, extension lifecycle, saved-function loading, sandbox behavior, partial updates, or renderers also require a `/reload` smoke test because those boundaries depend on live Pi integration.
