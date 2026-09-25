---
description: Reflect on session work and improve reusable Pit functions and their owning skills
argument-hint: "[focus]"
---

Review the work completed in this session, focusing on ${ARGUMENTS:-the entire session}. Identify reusable workflows that should become saved functions and high-confidence improvements to existing saved functions and their owning skills.

Work through this process:

1. Reconstruct the important work performed in the session from the conversation, tool calls, failures, corrections, and repeated operations already in context. Focus on workflows that actually occurred or are strongly likely to recur.
2. Use `functions.listAll()` through explicit injection: `async ({ functions: { listAll } }) => listAll({ limit: 20 })`. Read the returned `functions` page and follow `nextOffset` only as needed; use scope filters to narrow it. For relevant candidates, use `functions.getSaved(name)` via `async ({ functions: { getSaved } }) => getSaved(name)` to inspect the override chain, dependencies, and effects. Only `kind: "source"` has authored source; native globals are read-only.
3. Compare session workflows with the registry. For each candidate, decide whether to:
   - reuse an existing function unchanged;
   - extend the closest function with a parameter or explicit mode;
   - compose existing functions;
   - create one new function for a distinct reusable intent; or
   - decline the candidate because it is temporary, trivial, overly specific, or unsafe to generalize.
4. Prefer one parameterized function per intent. Do not create overlapping aliases or hide substantial control flow in untyped data. Preserve bounded outputs, typed inputs, sequencing of mutations, and explicit error handling.
5. Before replacing a function, inspect its direct dependencies, dependents, scope, and override state. Preserve compatible signatures when dependents rely on them, or update the dependency chain together.
6. Map each candidate to an existing owning skill, if any, and read that skill in full. Keep triggers, preconditions, result interpretation, recovery, and acceptance policy in the skill; keep repeatable execution, input validation, and bounded results in functions. When a helper is changed or promoted, update stale skill routing and runnable examples in the same authorized change. Prefer skill-only clarification when execution already exists; do not manufacture a function, skill, or parallel registry merely to connect them. Type-check executable examples against the real registry rather than asserting policy sentences.
7. Implement only high-confidence improvements now:
   - keep unproven helpers session-scoped;
   - use `functions.promote(name, summary)` only for stable, project-specific workflows in an enabled, trusted project;
   - use `functions.promote(name, summary, { to: "user" })` only for stable, project-independent workflows after explicit user confirmation;
   - update a project function only when project persistence is clearly intentional;
   - use `saveOnly: true` when validation should not trigger external effects;
   - otherwise execute a representative low-risk case before retaining the function.
8. Distinguish persisted source from active definitions: after file edits, disk tests do not certify what the current session will invoke. Follow the owning skill's reload/inspection and live smoke-test requirements, report remaining acceptance work, and do not create a session override merely to conceal stale project loading.
9. Do not remove functions, perform destructive operations, edit unrelated repository code, commit, or push unless the user explicitly asks.

Finish with a concise report containing:

- functions created, updated, composed, or promoted;
- owning skills updated, or deliberately left unchanged with a reason;
- existing functions intentionally left unchanged;
- candidates declined and why;
- any follow-up validation or real-world use still needed.

If no function change is justified, say so clearly instead of manufacturing one. Skill-only improvements are a valid outcome; do not claim live acceptance based only on disk validation.
