# Migrating to the unified function system

Pit 0.16.0 intentionally breaks the pre-0.16 saved-function and capability model. Pit does not migrate old source, storage, session entries, configuration, or API calls automatically.

Migrate important functions before or immediately after updating. Keep a copy of old files until the new definitions have been validated.

## Scope names

The old user-owned `global` scope is now named `user`.

```text
Old global function  -> user function
Built into Pit       -> global function
```

The new precedence order is:

```text
session > project > user > global
```

Global functions are immutable definitions shipped inside Pit.

## User storage

Move user functions from:

```text
${PI_CODING_AGENT_DIR}/pit/functions/
```

to:

```text
${PI_CODING_AGENT_DIR}/functions/
```

The default destination is:

```text
~/.pi/agent/functions/
```

Pit does not read the old directory after the breaking release.

## Project storage

Keep current project functions under:

```text
.pi/functions/
```

Move any remaining legacy project functions from:

```text
.pi/pit/functions/
```

to `.pi/functions/`. Pit no longer reads the legacy directory.

## Explicit function dependencies

Saved functions are no longer ambient lexical names.

Before:

```typescript
async ({ workspace }) => {
  const pkg = await workspace.read("package.json", { format: "raw" });
  return inspectPackage({ content: pkg.content });
}
```

After:

```typescript
async ({
  workspace: { read },
  inspectPackage,
}) => {
  const pkg = await read("package.json", { format: "raw" });
  return inspectPackage({ content: pkg.content });
}
```

Every called function must appear in the first parameter's nested dependency declaration.

## Method-level injection

Capturing a complete capability namespace is no longer supported.

Before:

```typescript
async function runTests({ npm }, input: { coverage?: boolean } = {}) {
  return npm.test({ coverage: input.coverage, raise: true });
}
```

After:

```typescript
async function runTests(
  { npm: { test } },
  input: { coverage?: boolean } = {},
) {
  return test({ coverage: input.coverage, raise: true });
}
```

Aliases remain available:

```typescript
async function readConfig({ workspace: { read: readFile } }) {
  return readFile("config.json", { format: "raw" });
}
```

Dynamic dependency access, rest bindings, and whole-namespace capture must be rewritten as explicit dependencies.

## Namespaced functions

Directory paths define dotted identifiers:

```text
functions/workspace/read.ts -> workspace.read
functions/validatePit.ts    -> validatePit
```

The declaration name must match the final path segment. For example:

```text
workspace/read.ts
```

must contain:

```typescript
async function read(dependencies, input) {
  // ...
}
```

Use the `typescript` tool's `functionId` parameter when creating a namespaced session override.

## Overrides and `$next`

A higher-scope definition with the same identifier overrides a lower definition. Overrides must preserve the lower function's call signature.

Use `$next` to decorate the lower implementation:

```typescript
async function read({ $next }, file: string, options?: ReadOptions) {
  if (file.startsWith("../")) {
    throw new Error("Reads must remain inside the project");
  }
  return $next(file, options);
}
```

Do not inject the function by its own public identifier to reach the lower definition; that resolves back to the active override.

Dependencies now resolve virtually. A project override may therefore affect dependencies used by user and global functions when those functions run in that project.

## Promotion

Change user promotion from:

```typescript
functions.promote(name, summary, { to: "global" })
```

to:

```typescript
functions.promote(name, summary, { to: "user" })
```

Project remains the default promotion target:

```typescript
functions.promote(name, summary)
```

Global functions cannot be created, promoted, removed, or edited by users.

## Session functions

Existing pre-0.16 session entries are not rewritten. Recreate any session function that must survive the upgrade using the explicit dependency form.

Finish or export important work from old sessions before updating. Navigating to an old branch does not make its legacy function definitions available to the new registry.

## Configuration and management APIs

Update configuration and scripts that use the old user-global terminology. Replace `global` with `user` where it refers to user-owned function storage or promotion.

Review `/functions` after migration and verify:

- the expected scope for each definition;
- override chains;
- direct dependencies;
- derived private effects;
- signature compatibility with lower definitions.

There are no legacy aliases for conflicting management APIs.

## Validate migrated functions

For each migrated function:

1. confirm its file path produces the intended dotted identifier;
2. make every direct function call explicit in the first parameter;
3. destructure individual methods instead of whole namespaces;
4. confirm an override preserves the lower signature;
5. use `$next` when wrapping a lower definition;
6. inspect its transitive effects in `/functions`;
7. invoke it in a fresh session before deleting the old copy.
