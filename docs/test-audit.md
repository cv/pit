# Test audit and evidence-backed cleanup

Audit baseline: `c06b39e` on `main`. Discovery was read-only; the two resulting cleanups were implemented after recording evidence and obtaining authorization. Test names and line references in the findings refer to that baseline. This is not a subsystem-wide deletion campaign. The earlier [change-detector inventory](test-contract-inventory.md) remains the record of the broad cleanup at `c81c9a1`.

## Scope and method

- Enumerated **101 `test/**/*.test.ts` files**, **652 test declarations** (table declarations counted once), and **2,260 direct `expect(...)` calls** using the TypeScript AST. No recognized test callback lacked an `expect`/`assert` token. This is a discovery heuristic, not proof that assertions are reachable or adequate.
- Scanned file reads, identity/computed expectations, ordered mock calls, snapshots, and focused/skipped-test markers. Those signals do not establish test value by themselves.
- Deep review concentrated on source formatting and Wasmtime executor selection, with adjacent executor tests, entry points, dependency types/source, Git history, and CI routing. Also inspected workflow-resource discovery, tool-input cases, process-result cases, and README consumers as retention examples. The other files received mechanical discovery, not full semantic review.
- Read root `AGENTS.md`; no scoped `AGENTS.md` was found. CI runs `package:check`, `check`, and coverage on Node 22/24. `vitest.config.ts` includes all test files by default and requires 98% for statements, branches, functions, and lines. No gate or threshold was changed.

## Findings

### A1 — Strengthen environment-override proof (medium priority)

**Test:** `loads environment artifact overrides with default filesystem operations`, `test/sandbox/wasmtime-loader.test.ts:146`.

**Actual detection:** creates a temporary CommonJS addon and component, stubs `PIT_FUNCTION_EXECUTOR`, `PIT_WASMTIME_ADDON`, and `PIT_WASMTIME_COMPONENT`, then checks only `configuredFunctionExecutor()` is defined. It catches exceptions during loading, but does not demonstrate that the returned executor uses those artifacts rather than Node or another backend. The fake addon has an empty method and the test never calls it.

**Counterfactual observed:** a temporary Vite transform replaced the loader's default environment-derived config with `{ backend: "node" }`. The exact existing test still passed: **1 passed, 18 deselected/skipped**. The transform was guarded against a missing source match. Production files on disk were untouched and the temporary config was removed. This is a test blind spot, not evidence that production currently ignores overrides.

**Owner and callers:** `src/sandbox/wasmtime-loader.ts` selects the backend; `src/index.ts` calls it without arguments and passes its result to `registerTypeScriptTool`. The selected executor is consumed through `runWithFunctionExecutor`. `createWasmtimeFunctionExecutor` retains the addon and component for use in `execute`.

**Remaining proof:** `loads resolved explicit artifacts into a Wasmtime executor` in the same file checks paths through injected operations, not the default environment/filesystem path. `test/sandbox/wasmtime-executor.test.ts` exercises dispatch/results using a directly supplied addon, bypassing the loader. Neither replaces this environment-boundary contract. The packaged-execution case only runs on Linux ARM64 and does not use these overrides.

**History:** the loader began as an opt-in spike at `62e1d31`; `4b5cecf` made Wasmtime the default and added this environment/filesystem case. `3f9217f` added implicit-load fallback. A defined executor alone cannot distinguish successful selection from fallback.

**Action:** retain and strengthen, not delete. Execute a prepared program through the environment-selected executor, with the temporary addon reporting which component bytes it received and returning a distinct protocol result. Assert that independent result/bytes. Keep guest-VM execution/isolation assertions in their existing owners; an addon fixture proves selection and transport, not Wasm isolation. Demonstrate the strengthened case rejects the ignored-environment counterfactual.

**Deletion unlocked:** none; the loader and executor factory have real production consumers. No new export or production injection seam is needed.

**Risk / focused proof:** medium: selection is a security-relevant default and tests must restore environment state and remove temporary files. Run:

```ts
runPitTargetedTests({
  files: ["test/sandbox/wasmtime-loader.test.ts", "test/sandbox/wasmtime-executor.test.ts"],
})
```

### A2 — Consolidate duplicate formatter-failure coverage (low priority)

**Test:** `falls back when the native formatter throws`, `test/tool/source-formatter.test.ts:44`.

**Actual detection:** mocks an asynchronously rejecting Oxfmt `format`, reloads the formatter module, and requires the original source `answer()` back. It detects a rejection escaping the formatter or fallback changing the input. It does not exercise loading a missing native module: Oxfmt is already imported, and the mocked function rejects on invocation.

**Owner and callers:** `src/tool/source-formatter.ts` catches formatter invocation failures and returns the input unchanged. It is used by `src/tool/typescript.ts` before preparation and by `src/renderers/typescript-tool-call.ts` for asynchronous display formatting. Oxfmt's installed API declares `format(...): Promise<FormatResult>`; its implementation asynchronously imports the native bindings when invoked.

**Stronger remaining proof:** `retries after a $name without blocking validation`, `test/tool/source-formatting-cache.test.ts:24`, has synchronous-throw and asynchronous-rejection rows. Each checks the unchanged first result, a successfully formatted retry, and two formatter calls. It exercises the same unconditional fallback path plus recovery from a cached failure. The expression-versus-arrow-function input difference does not change that catch path. Other tests still protect embeddability, semantic execution, malformed source, and ordinary formatting.

**History:** `c81c9a1` replaced formatter whitespace goldens with behavior contracts while retaining this fallback case. `c223bd9` later introduced shared formatting/cache tests and the stronger retry table, leaving overlapping failure coverage in the older suite.

**Action:** consolidate on the retry table; the older standalone fallback case is a removal candidate. Preserve both retry rows and their unchanged-input assertions. No production behavior change is proposed.

**Deletion unlocked:** the older test's `vi.resetModules`/dynamic import/`vi.doMock` cleanup block; no production or shared support deletion. The `vi` import remains needed by the semantic tests.

**Counterfactual follow-up at the same baseline:** the unmodified formatter and formatting-cache suites passed **10/10 tests**. Guarded temporary Vite transforms then changed only the formatter's exception handler in memory. Each probe selected the older fallback case and both retry rows; the seven unrelated cases were deselected.

| Injected defect                                             | Older fallback case      | Retained retry rows                                   |
| ----------------------------------------------------------- | ------------------------ | ----------------------------------------------------- |
| Rethrow the formatter error instead of returning the source | Failed on rejection      | Both failed on rejection                              |
| Append one space to the fallback source                     | Failed on changed output | Both failed at the first, unchanged-input assertion   |
| Return the source but omit failure-cache eviction           | Passed                   | Both failed at the second, successful-retry assertion |

These probes demonstrate the retained table catches both failure modes protected by the older case, plus a recovery regression the older case misses. There were no suite-load errors. Production and test files on disk were untouched; temporary configs/reports were removed. These observations were recorded before removing the older test; the implemented cleanup is described below.

**Risk / focused proof:** low: both tests exercise the same dependency boundary, and the stronger table's extra recovery coverage is demonstrated above. Validation scope for the consolidation:

```ts
runPitTargetedTests({
  files: ["test/tool/source-formatter.test.ts", "test/tool/source-formatting-cache.test.ts"],
})
```

## Retained signals and why

- **Formatter cache counts:** concurrent requests must share native formatting and failed work must be retryable. Call counts here observe the promised work reduction; they are not arbitrary internal choreography. Eviction/oversized-source checks protect bounded retention. Private capacity changes may warrant test maintenance, not automatic deletion.
- **Wasmtime target/identity checks:** platform coverage and explicit-vs-implicit fallback are meaningful support/default contracts. Keep them; A1 is about missing evidence at the environment boundary, not a blanket ban on backend identity assertions.
- **Process-result fixtures:** `parseProcessResult(processResult())` compares production parsing with an independently specified fixture. The suite also exercises rejection, sanitization, and error/warning precedence; it is not simply a fixture comparing itself to itself.
- **Tool input table:** source-like strings are actual inputs that determine whether JSON-string params may be decoded. String-admitting types and malformed/non-function programs are distinct compatibility cases, not source greps.
- **Workflow resources:** real Pi discovery and trusted-project graph validation protect usable resources. Required public skill names are a minimum contract, not an exhaustive copied file inventory. Do not add prose assertions for the new audit skill.
- **README examples:** compiling actual documented programs without host effects protects usable examples. It is not equivalent to asserting that README contains a preferred sentence.

## Proof and disposition

Before implementation, the focused baseline ran through `runPitTargetedTests()` for the formatter, formatting-cache, Wasmtime-loader, and workflow-resource suites: **4 files passed; 31 tests passed, 1 skipped**. The skipped test executes the packaged default prebuild only on Linux ARM64. The separate A1 counterfactual passed despite the deliberately wrong backend selection, as recorded above.

Implemented after the read-only audit:

- **A1:** replaced the existence-only check with `executes with the environment-selected addon and component using default filesystem operations`. It runs through the actual loader/default filesystem operations and executor, asserting the selected addon's distinct result and the component bytes received. The fixture only models the external addon protocol; it does not claim to execute or isolate a guest VM. No new production seam was added.
- **A2:** removed the older standalone formatter fallback case and its module reset/mock cleanup. Both retry rows remain unchanged.
- Added the audit skill, routed test work to it from `AGENTS.md` and `pit-delivery`, and extended the existing real-loader resource test to require its public name and model-invokable metadata. That authoring change has a distinct missing-resource failure mode and adds no copied policy assertions.

The strengthened A1 case now **fails on the previously surviving ignored-environment mutation**, receiving `guest-result` instead of the selected addon's response. A second counterfactual that discarded component bytes also failed at the result assertion. Both probes had no suite-load errors and removed all temporary artifacts. The owner and sibling suites passed after cleanup: **5 files, 43 tests passed, 1 Linux-ARM64-only case skipped**. Production and shared test-support code are unchanged.

The updated discovery case was run before the skill existed and failed specifically because `pit-test-audit` was missing. After adding the skill it passed through Pi's real loader (1 passed, 2 unrelated cases deselected). No prose assertions were added.

The first standard validation attempt failed against stale local dependencies (Pi `0.83.0`, Vitest `4.1.10`, and Oxfmt `0.62.0`), including missing `stripTerminalSequences` and model APIs. Before implementing the cleanup, `npm ci --no-audit --no-fund` synchronized the install to the existing lockfile (Pi `0.86.0`, Vitest `5.0.1`, Oxfmt `0.68.0`). No dependency manifest or lockfile changed, and none of those environment failures was used to justify deleting tests.

After synchronizing dependencies, `validatePit({ coverage: true, packageCheck: true })` passed static checks but stopped at one unchanged storage test: `rejects case and namespace collisions without a discovery-order winner` in `test/functions/user-storage.test.ts:198`. A focused rerun reproduced the failure. A temporary filesystem probe confirmed that writing `Thing.ts` and then `thing.ts` in this Mac's temporary directory leaves just `Thing.ts` containing the second write, so the fixture cannot create the two case-distinct candidates it expects. This test was retained unchanged; making its fixture portable is a separate follow-up. Local coverage was not reached. A separate `package:check` passed; the PR's Linux CI owns the remaining full-suite/coverage proof.

Production/tooling code and shared test support: **0 lines changed**. Test changes: **27 added, 26 removed** (net +1); the objective was stronger evidence, not deletion count. No runtime behavior or coverage threshold changed.

Both recorded findings are addressed. Wider renderer, storage, and sandbox-isolation audits remain separate scoped follow-ups; this report does not certify their entire test surface.
