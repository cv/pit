# Architecture

Pit is organized around feature boundaries. `src/index.ts` is the extension composition root; most implementation files belong to a domain directory instead of the source root.

## Source layout

- `src/capabilities/` defines the model-facing capability contract, registry, host composition, and small Pi control handlers.
- `src/functions/` owns session, project, and user-global saved functions, including state, persistence, dependency analysis, promotion, removal, and scoped runtime generation.
- `src/sandbox/` owns validation, compilation, wire protocol, process lifecycle, dispatch, and restricted execution.
- `src/tool/` owns TypeScript tool orchestration, source formatting, timing, metadata, and failure context.
- `src/workspace/` owns workspace paths, hashed reads and edits, search, and regex worker behavior.
- `src/execution/` owns progress snapshots, capability traces, and dashboard models.
- `src/renderers/` contains TUI and result presentation. Domain and execution modules must not depend on TUI renderer modules.
- `src/shared/` contains neutral helpers that are safe for lower-level domains.
- `src/generated/` contains generated artifacts and must not be edited manually.

The remaining files directly under `src/` are composition or cross-domain adapters. Do not add a general-purpose `utils.ts`; place helpers in the domain that owns their semantics or in `src/shared/` when they are intentionally neutral.

## Dependency rules

- Internal modules import concrete leaf modules rather than broad barrel files.
- Saved-function primitives may use `src/sandbox/validation.ts`, but must not depend on sandbox process execution.
- Sandbox validation must not depend on saved-function state or persistence.
- Execution state must not import TUI renderer modules.
- Capability registry and host modules are expected composition roots with high fan-out.
- Internal source imports must remain acyclic.

`npm run structure:check` enforces an acyclic source graph and limits authored files directly under `src/`. It is part of `npm run check`.

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
