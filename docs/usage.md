# Using Pit

[Documentation index](README.md) · [Global function reference](reference.md)

Talk to the agent normally; it writes the TypeScript. This guide explains that call-authoring model and how to inspect what happened.

## Build a call

Submitted code must be a TypeScript expression. It cannot contain imports.

Use an anonymous function for one-time work:

```ts
async ({ context: { get } }) => {
  return { cwd: (await get()).cwd };
}
```

Pit contextually types destructured dependencies. Dependency annotations are not necessary. Validation detects unknown functions, unknown methods, invalid arguments, missing awaits, and incompatible result values. Diagnostics include source locations.

Destructure every function the code uses in the first parameter. A function that uses none can omit its parameters, as in `async () => 42`, or write `({})` when it also takes `params` input.

### Pass large data in `params`

Use top-level `params` for large patches, generated file contents, commit messages, and other quote-heavy data. The second function parameter must have a type annotation:

```json
{
  "code": "async ({ workspace: { edit } }, input: { file: string; contents: string }) => edit(input.file, { revision: null, changes: [{ kind: 'replaceFile', content: input.contents }] })",
  "params": {
    "file": "src/generated.ts",
    "contents": "export const generated = true;\n"
  }
}
```

Top-level `params` work with a one-time function and with the first execution of a named function.

See [tool parameters](reference.md#tool-parameters) for JSON input normalization and optional-argument behavior.

### Control concurrency

Host calls are asynchronous. A host call starts when the program invokes the injected function. Pit waits for outstanding calls before it accepts a successful result.

Use `Promise.all` when all independent operations must succeed. Use `Promise.allSettled` or a local `catch` when an operation is optional. Sequence dependent operations. Do not run conflicting mutations in parallel.

This call preserves the successful Git result when an optional file does not exist:

```ts
async ({ workspace: { read }, git: { status: gitStatus } }) => {
  const results = await Promise.allSettled([
    read("optional.config.json", { format: "raw" }),
    gitStatus(["--short"]),
  ]);
  return results.map(result => result.status === "fulfilled"
    ? { ok: true, value: result.value }
    : { ok: false, error: String(result.reason) });
}
```

Unknown functions and methods fail closed at run time.

## Edit files safely

Hashed reads are the default. Each selected line contains a line number, a short hash, and its content. The result also contains a revision for the complete UTF-8 file:

```text
41:k3F9q|function example() {
42:7Qa2m|  return true;
43:p91Xs|}
```

An edit must use the current revision and current line anchors from `workspace.read` or `workspace.search`:

```ts
async ({ workspace: { edit } }) => edit("src/example.ts", {
  revision: "J8xM2pQa7vL4",
  changes: [
    { kind: "replace", start: "42:7Qa2m", content: "  return false;" },
    { kind: "insertAfter", anchor: "43:p91Xs", content: "export { example };" },
  ],
});
```

`replace` and `delete` apply to anchored line ranges. If the end anchor is absent, the change selects one line. `insertBefore` and `insertAfter` add content at an anchor. `replaceFile` rewrites a file. `deleteFile` deletes a file.

File creation requires `revision: null` and one `replaceFile` change. A rewrite or deletion of an existing file requires its current revision.

Pit validates all anchors against the supplied revision. It rejects overlapping changes. It applies compatible changes from the bottom of the file to the top. It converts inserted `\n` characters to the dominant line ending and preserves untouched bytes.

A successful edit invalidates all earlier revisions and anchors for that file. Read or search the file again before the next edit.

A read batch supports `fail-fast` and `settled` failure handling. An edit batch must target unique files. Pit validates every edit before the first write. If a later write fails, Pit makes a best-effort attempt to restore files that it already changed. A multi-file edit batch is not an atomic filesystem transaction.

## Read results in the TUI

The Pi TUI shows a compact call description during generation and execution. A spinner identifies active work, and the row shows live durations.

Press `Ctrl+O` to expand a tool row. The expanded row shows submitted source and the retained result. Pit does not show injected saved-function source in tool output.

Pit uses compact structured renderers for common function results. Compound objects can show recognized values as named sections. Unknown values use syntax-highlighted JSON. Git results use Git-aware summaries and styling while they preserve the serialized result.

Expanded running rows show a live host-call dashboard in source order. Each entry shows the namespace, method, state, and duration. Saved functions include their scope. While running, the dashboard keeps running, failed, and rejected calls plus the 12 most recent call groups, and a counted notice replaces older completed calls; the finished expanded view lists every retained call. Long-running shell calls show a sanitized, bounded tail of standard output and standard error. Partial updates do not enter the final model context.

Each invocation retains at most 128 runtime host-call traces for TUI attribution. A trace records names, source order, timing, duration, and outcome. Argument metadata contains bounded type-and-size summaries, not argument values. Additional calls set a truncation flag. Traces let saved-function results use the same renderers as direct calls. Ambiguous multi-call results use generic rendering.

Display formatting changes only the TUI. It does not change the serialized tool result.

## Execution and failures

Pit type-checks and compiles each call, resolves its injected dependencies, and runs it in a fresh Wasmtime/QuickJS sandbox. Return a JSON-compatible value to send a result back to the model. Intermediate values stay inside the call. See the [security model](security.md) for the host authority those dependencies expose.

Process methods return nonzero exit status as data by default; use `raise: true` when it should stop the workflow. Use a local `catch` or `Promise.allSettled` for failures the workflow can handle. See [common process options](reference.md#shell).

Failed TypeScript calls remain errors to Pi. The final result includes a bounded root error, saved-function path, function activity, and redacted host-call traces where available. Expanded failures show the function path and execution dashboard. Non-function failures keep an empty path and concise error text.

For recovery steps, see [troubleshooting](troubleshooting.md). To retain a useful call, continue to [saved functions](saved-functions.md).
