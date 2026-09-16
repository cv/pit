# Architecture

Pit is organized around feature boundaries. `src/index.ts` is the extension composition root; most implementation files belong to a domain directory instead of the source root.

## Source layout

- `src/capabilities/` defines the model-facing capability contract, registry, host composition, command preparation, and Pi control handlers.
- `src/functions/` owns session, project, and user-global saved functions, including state, persistence, dependency analysis, promotion, removal, and scoped runtime generation.
- `src/sandbox/` owns validation, compilation, wire protocol, process lifecycle, dispatch, and restricted execution.
- `src/tool/` is the application adapter for TypeScript tool orchestration, rendering, source formatting, timing, metadata, and failure context.
- `src/process/` owns host-process execution, bounded process results, and process-runner behavior.
- `src/workspace/` owns workspace paths, hashed reads and edits, search, and regex worker behavior.
- `src/execution/` owns progress snapshots, capability traces, and dashboard models.
- `src/renderers/` contains TUI and result presentation. Only renderer modules, the tool adapter, and root composition may depend on them.
- `src/shared/` contains neutral helpers that are safe for lower-level domains.
- `src/generated/` contains generated artifacts and must not be edited manually.

Files directly under `src/` are composition entry points or true cross-domain adapters. Do not add a general-purpose `utils.ts`; place helpers in the domain that owns their semantics or in `src/shared/` when they are intentionally neutral.

## Persistent function storage

Project functions are written to `.pi/functions/`. Pit also reads legacy `.pi/pit/functions/` files for compatibility, but a same-name new-path file takes precedence. Global functions remain under the Pi agent directory at `pit/functions/`. Storage location and explicit promotion APIs determine scope; source markers do not. `.pi/pit.json` remains the project opt-in configuration file.

## Dependency rules

- Internal modules import concrete leaf modules rather than broad barrel or compatibility-facade files.
- Saved-function primitives may use `src/sandbox/validation.ts`, but must not import sandbox execution or compilation entry points.
- Sandbox validation may parse saved-function source, but must not depend on saved-function state or persistence.
- Only `src/tool/`, root composition, and renderer modules may import TUI renderer modules.
- Capability registry and host modules are expected composition roots with high fan-out.
- Internal source imports must remain acyclic.

`npm run structure:check` enforces an acyclic source graph, limits authored files directly under `src/`, rejects saved-function imports through sandbox execution facades, validates renderer dependency direction, and verifies generated-contract placement. It is part of `npm run check`.

## Generated capability contract

Capability definitions are assembled in `src/capabilities/registry.ts`. Run:

```sh
npm run capabilities:generate
```

This writes `src/generated/capability-contract.d.ts`. The generated header marks the file as non-authored, and static checks verify that it is current.

## Tests

Tests are grouped by feature under `test/`, mirroring source domains where useful:

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
