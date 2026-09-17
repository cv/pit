# Wasmtime executor spike

This Linux ARM64 spike embeds Wasmtime in Pi's Node process through N-API. It is not a production executor and does not yet run Pit TypeScript.

The initial smoke test proves:

- a native N-API addon can host Wasmtime in-process;
- a fresh store can execute an untrusted module;
- finite fuel interrupts a runaway module;
- no WASI imports are linked;
- an async Wasmtime host import can await a JavaScript Promise through a threadsafe N-API callback;
- a custom Javy QuickJS guest has no WASI imports and dynamically compiles JavaScript;
- top-level JavaScript `await` can call that asynchronous host bridge; and
- Wasmtime trap causes survive the JavaScript boundary.

Build and run it without installing Rust on the host:

```sh
docker build -f Dockerfile.wasmtime-smoke -t pit-wasmtime-smoke:issue-82 .
docker run --rm pit-wasmtime-smoke:issue-82
```

The next step is to replace the numeric smoke import with Pit's bounded JSON call protocol, return a JSON-compatible program result, and run the JavaScript emitted by `prepareSandboxProgram`. Concurrent `Promise.all` host calls still require a non-blocking guest API rather than the current synchronous `pitCall` wrapper.
