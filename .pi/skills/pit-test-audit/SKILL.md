---
name: pit-test-audit
description: Gates new and changed Pit tests on observable contracts and credible regressions, and audits existing tests for duplication, implementation coupling, weak negative controls, and test-only production seams. Use before writing, changing, reviewing, or sweeping tests. Discovery is read-only; deletion requires recorded evidence.
---

# Pit test audit

## Purpose and modes

Optimize confidence per maintenance cost, not test count, deleted lines, or coverage percentage. This skill adapts the approach in OpenClaw's [test-audit skill](https://github.com/openclaw/openclaw/blob/main/.agents/skills/test-audit/SKILL.md) to Pit's boundaries, helpers, and delivery policy.

- **Authoring:** apply the gate below before adding or changing a test, including coverage-only work.
- **Focused audit:** scan read-only, then deeply review a few high-confidence candidates. Report findings before editing tests or production owners. An audit request alone does not require a cleanup.
- **Subsystem campaign:** agree on one owner and enumerate all its tests, support files, and overlapping boundary proof. Track reviewed, retained, changed, and deferred cases. Deliver coherent batches; refresh from current main before the next batch. Do not turn a campaign into a deletion quota.

Read root and scoped `AGENTS.md` first. Consult the [existing contract inventory](../../../docs/test-contract-inventory.md) so a previously reviewed false positive is not mistaken for new evidence. Use [pit-delivery](../pit-delivery/SKILL.md) for execution and delivery, and [pit-terminal-ux](../pit-terminal-ux/SKILL.md) for renderer or presentation-contract work.

## Four-question authoring gate

Answer these questions in the review or task notes; do not encode the answers as assertions about policy prose:

1. **Contract:** which observable behavior, invariant, or independently meaningful contract is protected?
2. **Regression:** which plausible defect would make the test fail, and at which assertion?
3. **Ownership:** why would the existing strongest boundary test not already catch that defect? Extend its typed table or fixture when possible. Another layer needs a distinct risk, such as transport, persistence, trust, or lifecycle behavior.
4. **Seams:** does the test require a production export, wrapper, switch, or injection hook with no production need? Prefer the real boundary. Do not introduce a new seam merely to reach private branches.

A bug regression must fail on the pre-fix behavior for the intended reason and pass after repair. Record that observation. A failure caused by fixture setup, an unrelated guard, or a broken mock does not prove the fix.

Use descriptive typed `it.each` rows for cases with the same setup and assertion shape. Keep lifecycle, concurrency, ordering, and heterogeneous workflows explicit. Do not hide substantial control flow in table data just to reduce line count.

## Discovery signals, not automatic verdicts

Look for:

- assertion-free probes, self-comparisons, and expectations computed by the function under test;
- copied implementation strings, policy sentences, file/export inventories, and exact private call shapes;
- duplicate proof at several layers without a distinct failure mode;
- identity or incidental-order assertions that reject behavior-preserving refactors;
- mocks that perform the behavior supposedly being tested, identical responses that hide swapped attribution, or fixtures that pre-supply the ordering/receipt the owner must produce;
- declared capability flags without evidence of the promised effect;
- a rejection that can pass through the wrong guard, or persistence checked in a store the exercised path never writes;
- names that promise execution, cancellation, fallback, or refresh while only asserting object existence;
- test-only production exports, globals, wrappers, or dead paths kept alive by their own tests.

Searches and AST counts only select candidates. Do not label every substring check, mock, static test, or slow test as junk. Narrow truncated searches and state the limits of any mechanical scan.

## Retention bar: Pit contracts that matter

Retain independent protection for:

- injected capability signatures, argument-safe process argv, correct repository/run targets, public source/data representations, and reflection;
- project trust, scope resolution and `$next`, promotion validation, rollback, and persistence;
- sandbox isolation, grants, cancellation, time/memory/protocol bounds, and absence of forbidden effects;
- hashed revisions/anchors, conflict rejection, atomic edits, and preservation of unrelated files;
- terminal sanitization bytes, meaningful outcomes, retained payloads, explicit omissions, width, and settled lifecycle behavior;
- package layout, native platform support, generated contract drift, architecture rules, defaults, and usable documentation examples.

Keep call ordering when it changes observable effects. Exact assertions are appropriate when the bytes, key, path, or public name are the contract. Source inspection can be the cheapest independent guard if it survives an identifier-only refactor and detects a genuine contract break. Dedicated check/package gates own their contracts; do not weaken them or coverage thresholds to make pruning pass.

Treat a valuable test that fails on the baseline as a possible product defect: reproduce it and investigate the owner, rather than deleting the test.

## Evidence required for each candidate

Read the complete test and production owner, entry point, relevant callers/callees, sibling implementations, overlapping tests, CI routing, and history. Inspect dependency source or types directly when the claim depends on an external API.

Record:

- baseline commit, exact test name, and file/line;
- the failure actually detected, and any claimed behavior not demonstrated;
- production owner and non-test callers of the seam;
- stronger remaining proof with its exact location, or why none is needed;
- relevant history and why the test/seam exists;
- proposed action: retain, strengthen, consolidate, remove, or defer;
- production/support deletion unlocked (explicitly say none when applicable);
- risk and the focused validation invocation.

Missing evidence means **defer**, not delete. If there is no stronger proof for an important contract, strengthen or relocate it. Keep read-only audit findings distinct from implemented changes. Record counterfactual probes separately from baseline passing tests; a surviving mutation demonstrates a coverage gap, not a production bug.

## Run a counterfactual through the saved workflow

Use `tests.probeMutation()` for a supported literal source mutation; do not recreate its temporary config/report/cleanup workflow. The caller must first establish a passing baseline for the same files and name filter. Read the owner freshly, review the proposed defect, and supply the mutation through tool `params` rather than editing production source on disk.

The marked example is type-checked against the actual project functions, not executed by the resource tests. Use a 300000 ms tool timeout for the sequential baseline and probe:

```ts pit-example
async (
  { tests: { runTargeted, probeMutation } },
  input: {
    label: string;
    owner: string;
    before: string;
    after: string;
    files: string[];
    testNamePattern?: string;
  },
) => {
  const baseline = await runTargeted({
    files: input.files,
    ...(input.testNamePattern === undefined ? {} : { testNamePattern: input.testNamePattern }),
    raise: true,
  });
  if (!("counts" in baseline) || !baseline.counts || baseline.counts.passed < 1) {
    throw new Error("No passing baseline assertions were reported; do not run the mutation");
  }
  return probeMutation(input);
}
```

Interpret the result before drawing a conclusion:

- A thrown runner/match/cleanup error is a probe failure, not evidence of a detected regression. Inspect the cause and any retained-artifact warning before retrying.
- `inconclusive: true` means no usable assertion proof, including empty selections or suite-load failures. Do not label it a killed or surviving mutation.
- With `mutationApplied: true` and `inconclusive: false`, inspect the failing test names and reasons. Only the intended assertion failures demonstrate sensitivity; a nonzero `code` alone does not. A passing mutant identifies a possible coverage gap, not a product bug or automatic deletion permission.
- Report omitted failures and shortened diagnostics explicitly. Narrow the files/filter when the decisive cause was not retained.

`tests.probeMutation()` mutates `src/` modules through a Vite transform and `.pi/functions` sources through the workflow test loader, which reads them with `readFile`. A workflow mutation applies only when a selected test loads its owner; otherwise the probe fails as not applied. Read failures from its `report`, not the runner's exit code.

The helper does not rewrite the owner, but selected tests still execute their normal effects. Use reviewed test files, run probes sequentially, and do not edit code while a runner is active. The workflow requires jq and a `/tmp`-capable host. Route environment/API failures through `delivery.inspectDependencies()` and the delivery skill's recovery guidance, not test deletion.

## Edit and validate one coherent batch

1. Record the evidence and scope before editing. Never edit source or tests while Vitest runs in the same checkout.
2. Prefer removing redundant tests and obsolete seams over adding wrappers or aliases. Do not chase net-negative LOC when that would discard independent proof.
3. Reuse boundary fixtures and `tests.runTargeted()` for the owner and relevant siblings. Use `testNamePattern` to isolate a case, without changing the meaning of a reported baseline.
4. Use the counterfactual composition above when it fits. If an experiment cannot be expressed by the helper, document the missing capability before a narrow `shell.execFile` fallback; preserve the same baseline, bounds, no-owner-rewrite, and cleanup requirements.
5. If removing a source/prose check, run the executable contract or policy gate that replaces it. For project skills, exercise Pi's real discovery API; do not add a test that copies the skill's sentences.
6. Delegate final review, changed-file formatting, standard validation, and Git readiness to [pit-delivery](../pit-delivery/SKILL.md), including its result interpretation and loaded-versus-disk checks. Do not run full tests and coverage concurrently. `delivery.auditCodeQuality()` measures maintainability signals, not test value.
7. Apply `pit-delivery`'s reload/live-acceptance requirements to any changed TUI, extension-loading, saved-function, sandbox, or partial-update behavior. Headless assertions do not certify interactive behavior.

Commit, push, open PRs, and close issues only when authorized. Do not use closing keywords before required interactive acceptance.

## Handoff

Report the reviewed scope and omissions, findings with evidence, retained false positives, actual edits, production/tooling versus test/support LOC, focused/full proof actually run (including failures and skips), and named follow-ups. State commit/PR/merge and live-acceptance status without implying unperformed delivery.
