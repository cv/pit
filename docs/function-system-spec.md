# Unified function system

- Status: Accepted; implementation in progress
- Target: Pit 0.16.0
- Tracking: [#82](https://github.com/cv/pit/issues/82)

## Summary

Pit will expose one public callable abstraction: a **function**. The current distinction between fixed host capabilities and saved functions will disappear from submitted TypeScript. Built-in operations such as `workspace.read`, user-authored workflows such as `validatePit`, and registry controls such as `functions.promote` will use the same typed dependency-injection and invocation model.

Functions form a layered registry:

```text
session > project > user > global
```

Global functions are shipped inside Pit. User functions live under `${PI_CODING_AGENT_DIR}/functions/`, whose default is `~/.pi/agent/functions/`. Project functions live under `.pi/functions/`. Session functions remain branch-local Pi session entries.

A higher scope may override a lower definition with a compatible signature. Dependencies resolve virtually through the active layer stack, and an override may invoke the next lower definition through `$next`.

Pit retains a small private host boundary for filesystem, process, network, Pi, and registry effects. Those private bindings are not public functions and cannot be overridden. The resolved transitive private-effect closure becomes the authoritative grant for each invocation.

This is an intentionally breaking design. Pit will not load, rewrite, or migrate legacy function definitions automatically.

## Goals

- Make built-in and user-authored callables indistinguishable to submitted TypeScript.
- Remove generated lexical saved-function bindings.
- Preserve ordinary dependency-injected function definitions that are easy to unit test.
- Permit user, project, and session overrides of Pit's global functions.
- Make dependencies, override provenance, and transitive host effects inspectable.
- Grant each invocation only the private host effects required by its resolved function graph.
- Keep the function model independent of the Node or Wasmtime execution backend.
- Preserve branch-local session state and commit-after-success behavior.

## Non-goals

- Backward compatibility with pre-0.16 function storage, scope names, source forms, or management APIs.
- Automatic migration or dual-reading of legacy paths.
- Defining the Wasmtime embedding or WIT ABI in this specification.
- Adding interactive per-effect approval policy in the first implementation.
- Allowing dynamic dependency discovery from submitted code.
- Making private host bindings overridable.
- Replacing Pi's single public `typescript` tool. Functions remain callables inside that tool.

## Terminology

### Function

A typed public callable. A function has an identifier, call signature, documentation, definition scope, declared direct dependencies, implementation, and derived private effects.

### Function identifier

A dotted path such as `workspace.read`, `npm.test`, or `validatePit`. The identifier is independent of the implementation scope.

### Definition

One implementation of a function identifier at one scope. Multiple definitions of the same identifier form an override chain.

### Scope

One of `global`, `user`, `project`, or `session`.

### Global function

An immutable definition shipped inside Pit. Global definitions form the bottom of the public override chain.

### User function

A user-owned definition stored under `${PI_CODING_AGENT_DIR}/functions/` and available across projects.

### Project function

A definition stored under `.pi/functions/` and loaded only for an enabled, trusted project.

### Session function

A definition stored in Pi's active session branch. Session definitions continue to follow branch navigation.

### Dependency

A function declared in the first parameter of another function or submitted program. Dependencies are injected as typed callables.

### `$next`

A special dependency available to an override. It invokes the next lower definition of the same function identifier.

### Private host binding

A non-public, non-overridable runtime operation that performs a host effect. Examples include filesystem access, process execution, HTTP requests, Pi state changes, and persistent registry mutations.

### Effect and grant

An effect identifies private host authority. A grant is the exact set of effects an invocation may request after its effective function graph has been resolved.

## Scope and storage

### Resolution order

Normal function references resolve in this order:

```text
session > project > user > global
```

The first available compatible definition is effective.

### Storage layout

Dotted identifiers map to directories:

```text
${PI_CODING_AGENT_DIR}/functions/validatePit.ts     -> validatePit
${PI_CODING_AGENT_DIR}/functions/workspace/read.ts  -> workspace.read
.pi/functions/validatePit.ts                        -> validatePit
.pi/functions/workspace/read.ts                     -> workspace.read
```

Global definitions use an equivalent package-owned manifest or source tree inside Pit. Their physical package path is not part of the public API.

The final identifier segment must match the top-level function declaration name. For example, `workspace/read.ts` must declare `read`.

Identifier segments must be valid TypeScript identifiers. The registry rejects reserved or prototype-sensitive segments, including `$next`, `__proto__`, `prototype`, and `constructor`.

A registry cannot contain a leaf/namespace collision. It cannot define both `workspace` and `workspace.read` in the same effective namespace.

### Canonical persistence policy

User source loads automatically, with no replacement for the old `globalFunctions.enabled` flag. Project configuration cannot disable user or package-owned global definitions. An absent user directory is empty and is created only on a successful write. External edits are discovered on reload/session start, not by a watcher.

Persistent paths must round-trip through the dotted identifier mapping. `workspace/read.ts` is canonical; `workspace.read.ts` is not an alternate spelling. Reject case-only collisions, reserved filesystem names, and leaf/namespace conflicts without selecting a discovery-order winner. Discover only regular implementation `.ts` files; skip declarations and temporary files. Do not follow symlinked files or subdirectories. Bound traversal and bytes read before parsing.

Invalid definitions reserve their identifiers: dependent invocations fail rather than silently falling back to a lower implementation. Keep bounded diagnostics and allow unrelated functions to run. Explicit removal or a corrected reload resolves the invalid definition.

User promotion validates portability against user/global definitions. Invocation still resolves dependencies virtually against the active layers. Persistent file replacement is atomic, but it is not a distributed transaction across the filesystem, Pi's session history, and other running Pi instances.

### Enablement

- Global functions are always enabled.
- User functions are loaded automatically from the active Pi agent directory.
- Project functions retain Pit's trusted-project and project-enablement requirements.
- Session functions are available on the active branch.

Disabling a scope does not delete its files.

### Session identifiers

A directly submitted named function uses its declaration name as its identifier by default. The `typescript` tool will accept an optional `functionId` when creating a namespaced session definition or intentionally overriding another identifier.

The final segment of `functionId` must match the submitted declaration name. An anonymous submission cannot set `functionId`.

## Source and invocation model

### Submitted programs

A submitted program receives functions through its first parameter:

```typescript
async (
  {
    workspace: { read },
    validatePit,
  },
  input: { file: string },
) => {
  const source = await read(input.file, { format: "raw" });
  return validatePit({ source: source.content });
}
```

`workspace.read` and `validatePit` are both functions. Their scopes and implementation kinds are not visible at the call site.

### Function definitions

Persistent and session definitions remain ordinary dependency-injected TypeScript functions:

```typescript
async function validatePit(
  {
    npm: { test },
    preparePitDelivery,
  },
  input: { coverage?: boolean } = {},
) {
  const tests = await test({ coverage: input.coverage, raise: true });
  const delivery = await preparePitDelivery();
  return { tests, delivery };
}
```

This form remains directly testable with ordinary mocks:

```typescript
await validatePit(
  {
    npm: { test: fakeTest },
    preparePitDelivery: fakeDelivery,
  },
  { coverage: true },
);
```

### Dependency declarations

The first parameter's nested object binding pattern is the authoritative direct dependency declaration.

Supported forms include direct bindings and aliases:

```typescript
async ({ workspace: { read } }) => read("README.md")
async ({ workspace: { read: readFile } }) => readFile("README.md")
```

The hardened source model rejects:

- rest bindings;
- computed dependency names;
- dynamic property access;
- capturing the complete dependency container;
- capturing a whole namespace such as `{ workspace }`;
- casts or indexing intended to bypass the declared shape.

Functions with no dependencies declare an empty object:

```typescript
async function answer({}, input: { value: number }) {
  return input.value * 2;
}
```

The runtime supplies only the declared direct dependencies. Injected objects use null prototypes and are frozen before untrusted code receives them.

### Calling conventions

The first parameter is implementation-only dependency injection and is omitted from the public call signature. Callers pass the remaining declared parameters. Overrides and `$next` are typed against that public signature. Functions otherwise retain their positional parameters; the first implementation release will not normalize all public calls to a single structured request object.

Internally, a function is modeled as:

```typescript
type FunctionCall<Arguments extends unknown[], Result> = (
  ...args: Arguments
) => Promise<Result>;
```

Existing global functions may therefore preserve familiar calls such as:

```typescript
read("package.json", { format: "raw" })
test({ coverage: true, raise: true })
```

User-authored functions may retain the existing convention of one optional input object.

### Direct recursion

A named function may call itself by its own declaration name. The runtime retains a bounded recursion depth.

Multi-function dependency cycles are rejected in the first implementation. `$next` edges are descending override edges and do not count as cycles.

## Registry and resolution

### Definition model

The conceptual definition record is:

```typescript
interface FunctionDefinition {
  id: string;
  scope: "global" | "user" | "project" | "session";
  implementation: SourceImplementation | NativeImplementation;
  signature: FunctionSignature;
  documentation: FunctionDocumentation;
  directDependencies: DependencyReference[];
  directEffects: PrivateEffect[];
  fingerprint: string;
}
```

Global definitions may initially be native-backed adapters around existing Pit host handlers. Native and source-backed global definitions must expose the same observable metadata, resolution behavior, tracing, grants, and override rules. Built-ins may migrate to shipped source incrementally.

### Virtual resolution

Ordinary dependencies resolve against the active invocation stack, regardless of the scope containing the requesting definition.

If global `validatePit` depends on `npm.test` and the project overrides `npm.test`, invoking `validatePit` in that project uses the project override:

```text
validatePit [global]
└── npm.test [project]
    └── $next
        └── npm.test [global]
```

This deliberately replaces Pit's current scope-pinned saved-function dependency semantics.

The first implementation does not expose scope-pinned dependency syntax. `$next` is the only public lower-layer resolution mechanism.

### `$next`

An override may declare `$next` in its dependency parameter:

```typescript
async function read(
  { $next },
  file: string,
  options?: ReadOptions,
): Promise<ReadResult> {
  if (file.startsWith("../")) {
    throw new Error("Reads must remain inside the project");
  }
  return $next(file, options);
}
```

`$next` resolves to the first lower definition of the same identifier. It has the established public signature of that function.

A definition that declares `$next` without a lower definition is invalid. Global definitions cannot declare `$next`.

### Override compatibility

Every override must be assignable to the next lower definition's public call signature:

- it must accept every argument accepted by the lower definition;
- its resolved result must be assignable to the lower result;
- it may not weaken required error or serialization guarantees.

An incompatible definition fails loading or session preparation without changing live state. A breaking contract requires a new function identifier.

### Resolved graph

Preparation constructs a graph whose nodes identify a concrete definition by function identifier, scope, and source fingerprint. Edges represent virtual dependencies, `$next`, and private host effects.

Preparation:

1. parses the root dependency declaration;
2. resolves each requested identifier through the active scope stack;
3. parses or loads each definition's direct dependencies;
4. recursively resolves virtual and `$next` edges;
5. rejects missing definitions, incompatible overrides, namespace conflicts, and unsupported cycles;
6. derives the exact private-effect closure;
7. compiles only the reachable source closure; and
8. creates an attenuated direct dependency object for each source definition.

Changing an override may change both executable source and derived effects. Caches must include effective definition fingerprints and resolved graph identity.

## Global functions and private host bindings

### Public global functions

Pit will register its default callable surface as global functions. The initial set should cover the current public capability methods, including workspace, Git, npm, GitHub, shell, HTTP, UI, context, session, commands, models, runtime, and function-management operations where their behavior remains supported.

Global functions are:

- immutable and always available;
- inspectable through function-management UI and APIs;
- overridable unless explicitly sealed;
- typed and documented like every other function;
- attributable in execution traces;
- source-backed or clearly labeled native-backed.

### Sealed functions

Private host bindings are never public registry entries. Registry administration exposed to submitted code uses sealed global function identifiers. Sealed definitions can be invoked and inspected but cannot be overridden or removed.

The sealed set must be minimal and explicitly documented. Function listing, inspection, promotion, and removal must not expose private host handles or credentials.

### Private boundary

Private host bindings perform actual effects and remain the backend's stable authority boundary. A future Wasmtime backend may express this boundary through WIT. The public function registry remains independent of that representation.

No submitted, user, project, or session source may refer to a private binding directly. Global source definitions receive private bindings only through package-owned, validated metadata.

## Grants and effects

### Grant derivation

A public function name is not an authority grant. Pit computes authority from the resolved graph's transitive private effects.

For example:

```text
workspace.read [project]
├── http.request [global]
│   └── private network-request
└── $next
    └── workspace.read [global]
        └── private filesystem-read
```

Calling `workspace.read` in this project requests both network and filesystem-read authority.

### Initial policy

The first implementation may permit every registered private effect by default, matching current product behavior, but it must grant an invocation only its derived effect set. Requests outside that set fail in the trusted host.

Interactive approval, path policy, command policy, and destination policy may be added later without changing function resolution.

### Enforcement

Grant checks are authoritative in the trusted host dispatcher or Wasmtime host, not only in generated guest objects. The guest receives attenuated dependencies for usability and defense in depth.

Dynamic dependency or private-effect calls are not permitted. A malformed or forged runtime request outside the resolved grant fails even if the requested host method exists globally.

Argument-level validation remains mandatory. An effect grant does not by itself authorize an arbitrary path, command, repository, URL, or persistent mutation.

### Introspection

Function inspection and execution traces show:

- requested function identifier;
- effective definition scope and source;
- override chain;
- direct function dependencies;
- `$next` resolution;
- direct and transitive private effects;
- rejected out-of-grant requests.

## Type checking and documentation

Pit generates contextual declarations from the effective registry. Namespaced identifiers appear as nested dependency properties, while leaf definitions retain their exact call signatures.

Only declared root dependencies and their reachable closure need runtime source injection. Diagnostics may list bounded available function names, but availability does not imply injection or grant.

Persistent user and project source retains the existing documentation requirement. Global functions ship equivalent summaries, parameter documentation, call signatures, provenance, and effect metadata.

Prompt catalogs remain bounded. They describe effective functions and call out overrides without copying all implementation source into the model context.

## State and lifecycle

### Session preparation and commit

Named direct submissions remain transactional:

1. prepare the candidate session definition and effective registry;
2. validate its identifier, source, dependencies, signature, graph, and effects;
3. execute against the candidate graph unless `saveOnly` is set;
4. append the session entry and update live state only after success.

Failure cannot install a partial definition.

### Branch behavior

Session definitions and tombstones remain branch-local. Session start, replacement, reload, and tree navigation reconstruct the session layer and resolve the effective graph deterministically.

### Promotion

Promotion targets are `project` and `user`. Global is not writable.

```typescript
functions.promote("validatePit", "Runs Pit's validation gates")
functions.promote("validatePit", "Runs Pit's validation gates", { to: "user" })
```

Promotion writes the target definition, appends a session tombstone, removes the session override, and re-resolves the graph only after persistent storage succeeds.

A session definition whose dependencies cannot resolve validly in the target environment cannot be promoted. User promotion may not depend on project- or session-only definitions unless the promoted source is explicitly changed first.

### Removal

Session, project, and user definitions may be removed subject to dependency and confirmation rules. Global definitions cannot be removed. Removing an override reveals the next lower definition.

Management APIs use the new scope names and do not retain `global` aliases for user storage.

## Management experience

`/functions` becomes the manager for the complete layered registry. It must distinguish effective definitions from shadowed lower definitions and show entries such as:

```text
workspace.read
  effective: project
  project: .pi/functions/workspace/read.ts
  user:    ~/.pi/agent/functions/workspace/read.ts
  global:  <pit builtin>
```

The manager supports:

- listing effective functions and all definitions;
- filtering by scope;
- inspecting source or native metadata;
- inspecting signatures, dependencies, override chains, and effects;
- promoting session definitions to project or user;
- removing session, project, and user definitions;
- explaining why a definition failed loading or why a grant was rejected.

Global and sealed definitions are read-only.

## Breaking change policy

Pit 0.16.0 makes a clean break. The implementation must not include compatibility or automatic migration for:

- legacy lexical saved-function calls;
- the old meaning of `global` as user-owned storage;
- `${PI_CODING_AGENT_DIR}/pit/functions/`;
- `.pi/pit/functions/`;
- legacy scope source markers;
- `{ to: "global" }` promotion;
- old function-management method names whose semantics conflict with the new scopes;
- sandbox options and runtime generation paths used only by the old lexical model.

Old files are left untouched and ignored. Old session entries are not rewritten. Existing legacy support and migration branches must be removed rather than carried into the new architecture.

The release must include [the migration guide](function-system-migration.md) and prominent release notes.

## Implementation outline

1. Introduce a layered function registry with `global`, `user`, `project`, and `session` definitions.
2. Register current capability methods as typed global function definitions backed by existing host handlers.
3. Add namespaced identifiers, path discovery, effective namespace validation, and signature-compatible overrides.
4. Replace lexical reference discovery with explicit nested dependency-declaration analysis.
5. Resolve virtual dependencies, `$next`, reachable source, and private effects in one graph.
6. Generate attenuated direct dependency objects and enforce invocation grants in the trusted host.
7. Update session persistence, user and project storage, promotion, removal, prompt catalogs, traces, renderers, and `/functions`.
8. Delete legacy storage readers, lexical wrappers, scope aliases, and migration code.
9. Update architecture, security, README, package verification, and release documentation.
10. Validate both native-backed global definitions and source-backed user overrides, then smoke-test reload, branch navigation, concurrency, cancellation, timeout, and grant rejection.

## Acceptance criteria

- Submitted TypeScript invokes every public callable through explicit dependency injection.
- No saved function is injected as a generated lexical binding.
- Global, user, project, and session definitions share one registry and invocation model.
- Resolution follows `session > project > user > global`.
- Dependencies resolve virtually through the active invocation environment.
- Compatible overrides and `$next` work across every adjacent scope combination.
- Incompatible overrides fail before mutating live state.
- Only direct dependencies are injected into each source function.
- Only reachable source definitions are compiled.
- The trusted host rejects private-effect calls outside the resolved invocation grant.
- Global functions are immutable, inspectable, and overridable unless sealed.
- User functions load from `${PI_CODING_AGENT_DIR}/functions/`.
- Project functions remain trust-gated and branch-local session behavior is preserved.
- Promotion targets only project or user scopes.
- Legacy paths, lexical runtime support, aliases, and migration code are removed.
- Documentation includes the migration guide and the effective override/effect model.
