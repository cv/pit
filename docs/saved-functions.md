# Saved functions

[Documentation index](README.md) · [Function-management reference](reference.md#functions)

Keep an operation when representative use has shown it is worth repeating. Prefer extending or composing an existing function over adding another name for the same intent.

## Reuse a workflow

Use a named top-level function for work that can recur:

```ts
async function runTests({ npm: { test } }, input: { coverage?: boolean } = {}) {
  return test({ coverage: input.coverage, raise: true });
}
```

Pit validates and runs the function. It saves the function only after execution succeeds.

Set `saveOnly` to `true` to validate and save a function without execution. A save-only definition cannot use top-level `params`:

```json
{
  "code": "async function runChecks({ npm: { test } }) { return test({ raise: true }); }",
  "saveOnly": true
}
```

Supply top-level `params` when the first execution needs input:

```json
{
  "code": "async function inspect({ workspace: { read } }, input: { file: string }) { return read(input.file, { format: 'raw' }); }",
  "params": { "file": "README.md" }
}
```

Call a saved function through explicit dependency injection:

```ts
async ({ runTests }) => runTests()
```

```ts
async ({ runTests }) => runTests({ coverage: true })
```

Directly submitted named functions become session functions. They survive reloads and follow the active session branch. A replacement is rejected if it invalidates a dependent function.

Saved functions can call other saved functions. Pit injects only referenced functions and their transitive dependencies into each sandbox. Types remain available across calls. Nested calls have a maximum depth of 32.

The effective registry resolves session, then project, then user, then immutable Pit global definitions. User-authored source has these limits; built-ins do not count toward them:

- 64 functions.
- 100 KB for one function.
- 1 MB of combined saved source.

Successful tool results include a compact, compaction-safe catalog of active session-function signatures. Effective user and project functions are documented in the system prompt instead of being repeated in every result. Catalogs contain only complete signatures and report omitted entries when they reach the output budget. `context.get().savedFunctions` also lists all effective names.

Pit tracks only in-memory invocation counts by function name; it does not retain arguments, source, or results as usage telemetry. After five invocations in one loaded branch lifecycle, a non-temporary session function receives one bounded suggestion to use `functions.promote(name, summary)`. User functions, project functions, session overrides, and names that look temporary are excluded. Reload and session-tree navigation reset counts and suggestion state.

## Functions that inject tools

A custom function can inject [other Pi tools](usage.md#call-other-pi-tools) like any other dependency:

```ts
async function openIssues({ tools: { mcp__github__list_issues } }, input: { repo: string }) {
  const issues: Array<{ number: number }> = JSON.parse(
    await mcp__github__list_issues({ owner: "acme", repo: input.repo }),
  );
  return issues.map((issue) => issue.number);
}
```

Which tools are callable can change between sessions and during one: an MCP server can be disabled or still connecting, or an extension can be removed. While a tool it injects is missing, the function is kept rather than rejected. `/functions` marks it `(unavailable)`, not `(invalid)`, and a call that uses it fails with `Function "openIssues" is unavailable: …` and the reason. The function works again as soon as the tool is callable.

While the tool is missing, Pit can't check the function's use of it, so arguments and results of that tool are loosely typed until it returns.

## Namespaced session functions

Set the optional `functionId` tool parameter to give a named definition a dotted identity:

```json
{
  "functionId": "company.check",
  "code": "async function check({}, input: { value: number }) { return input.value * 2; }",
  "params": { "value": 21 }
}
```

The final identifier segment must match the declaration name. Anonymous submissions cannot set `functionId`. Omitting it keeps the declaration name as the identity. Namespace collisions, reserved segments, and attempts to override sealed registry-management functions are rejected before saving.

Invoke the definition with nested injection:

```ts
async ({ company: { check } }) => check({ value: 21 })
```

`company.check` and `other.check` are separate definitions even though both declare `check`. Use the full identifier for inspection, removal, and promotion. Promoting `company.check` writes `company/check.ts` in the selected persistent directory without renaming the declaration. Reload and branch navigation preserve the full identity.

## Compatible overrides and `$next`

An override must accept the lower definition's arguments and return a compatible result. Pit checks the public call signature without the first dependency parameter, including optional/rest argument requirements. Incompatible definitions fail before a session entry or persistent file is changed. Use a new identifier for a breaking contract; annotate generic return types when preserving a type-parameter relationship is important.

Declare `$next` to invoke the next lower implementation of the same identifier:

```json
{
  "functionId": "context.get",
  "code": "async function get({ $next }) { const result = await $next(); return { ...result, cwd: result.cwd + '/decorated' }; }",
  "saveOnly": true
}
```

`$next` is definition-relative: session → project → user → global, skipping absent layers. Its arguments and result are typed from the lower implementation. An anonymous program cannot declare `$next`, and a definition with no lower implementation is invalid. Ordinary dependencies remain virtual and use the active highest-layer definition. This includes source-backed globals: `git.*`, `npm.*`, and `gh.*` inject `shell.execFile`, so overriding it also affects those command functions. `/functions` exposes their source and dependencies; see [architecture](architecture.md#source-backed-command-globals) for the implementation.

Persistent files may declare `$next` too. Promotion re-resolves it relative to the destination: moving a session decorator to project storage changes its next target from the old project definition to the user/global definition. If no valid lower target remains, promotion is rejected without replacing the file or removing the session definition.

Removing an override reveals a lower definition only if the resulting chain remains valid. A required `$next` target cannot be deleted out from under a dependent override. Host grants include only effects reachable at execution; a lower implementation used solely for signature checking does not add authority.

## Reuse user functions

User functions load automatically from `paths.user` in `.pi/pit.json`, by default `${PI_CODING_AGENT_DIR}/functions/` (`~/.pi/agent/functions/`); see [configuration](configuration.md#choose-function-directories). No user enablement flag is required. Global functions are immutable built-ins owned by Pit, not files owned by the user.

Use `functions.promote(name, summary, { to: "user" })` or **Save to user scope** in `/functions`. User promotion and removal require interactive confirmation. Promotion rejects project- or session-only dependencies; promote stable dependencies first. At invocation, dependencies resolve virtually against session, project, user, and global layers.

Files have one documented function declaration and canonical path-derived identifiers: `company/check.ts` declares `check` and is injected as `company.check`. Alternate dotted filenames, case-only collisions, and leaf/namespace collisions are rejected. Discovery is bounded; symlinked subdirectories are not followed and symlinked function files are rejected. Invalid definitions reserve their identifier so calls cannot silently fall back to a lower implementation. Fix or explicitly remove the invalid definition, then reload external edits.

## Share trusted project functions

Project functions load in every project Pi trusts, from `paths.project` in `.pi/pit.json` (default `.pi/functions`); see [configuration](configuration.md#choose-function-directories).

Use `functions.promote(name, summary)` or **Save to project** in `/functions` to persist a session function. Pit writes a documented source file like this:

```ts
/**
 * Runs repository tests.
 *
 * @param input.coverage - Enable coverage.
 */
async function runTests({ npm: { test } }, input: { coverage?: boolean } = {}) {
  return test({ coverage: input.coverage, raise: true });
}
```

If the definition already has a JSDoc block, the summary replaces that block's summary paragraph; other paragraphs and tags such as `@param` are kept.

Project functions use the same execution rules as session functions. Pit retains a session definition after successful execution, or after static validation when `saveOnly` is `true`; promotion is the separate persistence step.

Pit stores project functions as readable TypeScript files in `paths.project`; scope comes from storage location. A named definition submitted directly creates a session override; promote it explicitly to update the project version and clear that override.

Pit loads project source only for a project Pi trusts. The function still runs in the same sandbox as a session function.

Persistent removal is blocked when saved functions depend on the target. Inspect `functions.planRemoval(name, scope?)` before removing a definition. Session removal rejects dependent cascades unless `functions.removeSession(name, { cascade: true })` explicitly opts in. See the [function-management reference](reference.md#functions) for the scoped inspection, promotion, and removal methods.

## Manage all function definitions

Run `/functions` to open the interactive manager. It includes built-in globals as well as user, project, and session definitions. Authored definitions appear first; **Filter scope…**, **Show all definitions**, and page controls expose lower, shadowed definitions without flooding the display.

```text
/functions list
/functions list global
/functions list all
/functions show workspace.read global
/functions show company.check user
/functions delete runTests
```

Inspection shows implementation kind, effective scope, origin, public signature, override-chain paths, resolved dependencies, `$next`, and direct/transitive effects. Native globals show package-owned metadata—not invented source—and have no mutation actions. All registry-management `functions.*` globals are sealed. Invalid persisted definitions show loading diagnostics; fix their files and reload. Invalid attempts to override sealed globals do not disable those management functions.

Select a session definition to inspect it, promote it, or delete it. Project and user removal act on the selected writable scope, never on a global beneath it. `/functions delete` remains a session-only, confirmed branch-local deletion with explicit dependent-cascade handling.

Programmatic inspection uses the same registry:

```ts
async ({ functions: { listAll, getSaved } }) => {
  const page = await listAll({ scope: "global", limit: 10 });
  const read = await getSaved("workspace.read", "global");
  return { total: page.total, nextOffset: page.nextOffset, names: page.functions.map(fn => fn.name), read };
}
```

`listAll()` returns `{ functions, total, offset, nextOffset? }`, not an array. Its default page size is 50, with a maximum of 200. By default it lists effective definitions; `allDefinitions: true` includes shadowed layers. A scope filter selects definitions from that scope, whether effective or shadowed.

## Reflect on reusable work

Pit packages a `/pit-reflect [focus]` prompt template. It reviews work completed in the current session, compares recurring workflows with the effective saved-function registry, and makes only high-confidence additions or improvements. It prefers extending or composing existing functions, keeps unproven helpers session-scoped, and reports when no new function is justified.
