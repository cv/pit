# Wasmtime executor spike

This Linux ARM64 spike embeds Wasmtime in Pi's Node process through N-API. It is not a production executor and does not yet run Pit TypeScript.

The initial smoke test proves:

- a native N-API addon can host Wasmtime in-process;
- a fresh store can execute an untrusted module;
- finite fuel interrupts a runaway module;
- no WASI imports are linked;
- an async Wasmtime host import can await a JavaScript Promise through a threadsafe N-API callback;
- a custom Javy QuickJS guest has no WASI imports and dynamically compiles JavaScript;
- top-level JavaScript `await` can call that asynchronous host bridge;
- bounded UTF-8 JSON requests and responses cross the guest boundary without WASI;
- JavaScript emitted by `prepareSandboxProgram` executes and returns a JSON-compatible result; and
- Wasmtime trap causes survive the JavaScript boundary.

Build and run it without installing Rust on the host:

```sh
docker build -f Dockerfile.wasmtime-smoke -t pit-wasmtime-smoke:issue-82 .
docker run --rm pit-wasmtime-smoke:issue-82
```

Concurrent `Promise.all` host calls are now the main blocker: the current synchronous QuickJS `pitCall` wrapper suspends the Wasm instance for each host request, so calls cannot overlap. A production guest needs a queued non-blocking API or Component Model async task support.
