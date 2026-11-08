---
description: Reflect on session work and improve reusable Pit functions and their owning skills
argument-hint: "[focus]"
---

Review the work completed in this session, focusing on ${ARGUMENTS:-the work since this prompt last ran in this session, or the entire session if it has not run}. Identify reusable workflows that should become saved functions and high-confidence improvements to existing saved functions and their owning skills.

Work through this process:

1. Reconstruct the important work in scope from the conversation, tool calls, failures, corrections, and repeated operations already in context. Focus on workflows that actually occurred or are strongly likely to recur. Do not reopen candidates an earlier reflection already settled unless new evidence changes the decision.
2. Start from the user and project function catalogs in the system prompt and the global functions in the tool description. List session functions with `async ({ functions: { listAll } }) => listAll({ scope: "session" })`; list other scopes only when a catalog is missing or stale. For relevant candidates, use `async ({ functions: { getSaved } }) => getSaved(name)` to inspect the override chain, dependencies, and effects. Only `kind: "source"` has authored source; native globals are read-only.
3. Compare session workflows with the registry. For each candidate, decide whether to:
   - reuse an existing function unchanged;
   - extend the closest function with a parameter or explicit mode;
   - compose existing functions;
   - create one new function for a distinct reusable intent; or
   - decline the candidate because it is temporary, trivial, overly specific, or unsafe to generalize.
4. Prefer one parameterized function per intent. Do not create overlapping aliases or hide substantial control flow in untyped data. Preserve bounded outputs, typed inputs, sequencing of mutations, and explicit error handling.
5. Before replacing a function, inspect its direct dependencies, dependents, scope, and override state. Preserve compatible signatures when dependents rely on them, or update the dependency chain together.
6. Map each candidate to an existing owning skill, if any, and read that skill in full. Keep triggers, preconditions, result interpretation, recovery, and acceptance policy in the skill; keep repeatable execution, input validation, and bounded results in functions. When a helper is changed or promoted, update stale skill routing and runnable examples in the same authorized change. Prefer skill-only clarification when execution already exists; do not manufacture a function, skill, or parallel registry merely to connect them. Type-check executable examples against the real registry rather than asserting policy sentences.
7. Implement high-confidence improvements now, in this turn. Do not end the turn with a plan: either carry out a change or list it as a proposal in the report.
   - Use `saveOnly: true` when validation should not trigger external effects; otherwise execute a representative low-risk case before retaining the function.
   - Call a newly saved function in a later tool call: a definition saved in the same parallel batch is not injectable yet.
   - Keep a function session-scoped until it has run on a real case.
   - Choose a destination for each exercised, stable function: the project for project-specific workflows, the user for project-independent ones. In a trusted project, promote project-specific workflows with `functions.promote(name, summary)`; update an existing project function only when project persistence is clearly intentional.
   - When a promotion needs the user's decision (user scope, an untrusted project, or an uncertain destination), ask once with `ui.confirm` when the UI is available, naming each function and its destination, then promote what the user approves with `functions.promote(name, summary)` or `functions.promote(name, summary, { to: "user" })`. Without a UI, put the question in the report.
   - A promoted definition must be one top-level `async function` declaration.
8. Distinguish persisted source from active definitions: after file edits, disk tests do not certify what the current session will invoke. Follow the owning skill's reload/inspection and live smoke-test requirements, report remaining acceptance work, and do not create a session override merely to conceal stale project loading.
9. Do not remove functions, perform destructive operations, edit unrelated repository code, commit, or push unless the user explicitly asks. You may name overlapping, superseded, or unused functions as consolidation candidates in the report.

Finish with a concise report. Do not retell the session; give each item one line of evidence:

- functions created, updated, composed, or promoted, and how each was tested;
- owning skills updated, or deliberately left unchanged with a reason;
- plausible candidates among existing functions intentionally left unchanged;
- candidates declined and why;
- next steps the user can approve as written: changed files with a suggested commit message, pending promotions with their destinations, required `/reload` and live smoke tests, and consolidation candidates.

If no function change is justified, say so clearly instead of manufacturing one. Skill-only improvements are a valid outcome; do not claim live acceptance based only on disk validation.
