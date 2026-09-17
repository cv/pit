# Wasmtime executor spike

This Linux ARM64 spike embeds Wasmtime in Pi's Node process through N-API. It is not a production executor and does not yet run Pit TypeScript.

The initial smoke test proves:

- a native N-API addon can host Wasmtime in-process;
- a fresh store can execute an untrusted module;
- finite fuel interrupts a runaway module;
- no WASI imports are linked;
- an async Wasmtime host import can await a JavaScript Promise through a threadsafe N-API callback; and
- Wasmtime trap causes survive the JavaScript boundary.

Build and run it without installing Rust on the host:

```sh
docker build -f Dockerfile.wasmtime-smoke -t pit-wasmtime-smoke:issue-82 .
docker run --rm pit-wasmtime-smoke:issue-82
```

The next spike must preserve Pit's TypeScript authoring model. It will evaluate compiled JavaScript in a QuickJS/Javy WASM guest and connect that guest to the proven asynchronous host callback before this addon can implement `FunctionExecutor`.
