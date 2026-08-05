---
description: Reflect on session work and improve reusable Pit functions
argument-hint: "[focus]"
---

Review the work completed in this session, focusing on ${ARGUMENTS:-the entire session}. Identify reusable workflows that should become saved functions and high-confidence improvements to existing saved functions.

Work through this process:

1. Reconstruct the important work performed in the session from the conversation, tool calls, failures, corrections, and repeated operations already in context. Focus on workflows that actually occurred or are strongly likely to recur.
2. Inspect the effective function registry with `async ({ functions }) => functions.listAll()`. For relevant candidates, inspect source and dependency metadata with `async ({ functions }) => functions.getSaved(name)` so output stays bounded.
3. Compare session workflows with the registry. For each candidate, decide whether to:
   - reuse an existing function unchanged;
   - extend the closest function with a parameter or explicit mode;
   - compose existing functions;
   - create one new function for a distinct reusable intent; or
   - decline the candidate because it is temporary, trivial, overly specific, or unsafe to generalize.
4. Prefer one parameterized function per intent. Do not create overlapping aliases or hide substantial control flow in untyped data. Preserve bounded outputs, typed inputs, sequencing of mutations, and explicit error handling.
5. Before replacing a function, inspect its direct dependencies, dependents, scope, and override state. Preserve compatible signatures when dependents rely on them, or update the dependency chain together.
6. Implement only high-confidence improvements now:
   - keep unproven helpers session-scoped;
   - use `functions.promote(name, summary)` only for stable, project-specific workflows in an enabled, trusted project;
   - use `functions.promote(name, summary, { to: "global" })` only for stable, project-independent workflows after explicit user confirmation;
   - update a project function only when project persistence is clearly intentional;
   - use `saveOnly: true` when validation should not trigger external effects;
   - otherwise execute a representative low-risk case before retaining the function.
7. Do not remove functions, perform destructive operations, edit unrelated repository code, commit, or push unless the user explicitly asks.

Finish with a concise report containing:

- functions created, updated, composed, or promoted;
- existing functions intentionally left unchanged;
- candidates declined and why;
- any follow-up validation or real-world use still needed.

If no function change is justified, say so clearly instead of manufacturing one.
