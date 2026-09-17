# Wasmtime executor spike

This Linux ARM64 spike embeds Wasmtime in Pi's Node process through N-API. It is not yet a production executor.

The smoke test proves:

- a native N-API addon can host Wasmtime in-process;
- a fresh store can execute an untrusted module;
- finite fuel interrupts a runaway module;
- a custom rquickjs component dynamically executes JavaScript;
- `pitCall()` returns pending JavaScript Promises instead of suspending the component;
- the host drains bounded JSON requests in batches of at most 32;
- independent host Promises execute concurrently;
- JavaScript emitted by `prepareSandboxProgram` executes and returns a JSON-compatible result; and
- Wasmtime trap causes survive the JavaScript boundary.

The rquickjs component imports WASI Preview 2 runtime interfaces required by the Javy runtime crate. The host links those imports to a fresh `WasiCtx` with no inherited filesystem, environment, network, arguments, or stdio. Removing those runtime imports remains a hardening goal.

Build and run it without installing Rust on the host:

```sh
docker build -f Dockerfile.wasmtime-smoke -t pit-wasmtime-smoke:issue-82 .
docker run --rm pit-wasmtime-smoke:issue-82
```

## Queued rquickjs guest

The guest protocol is defined by `queued-guest/wit/world.wit`. JavaScript calls create pending Promises and enqueue requests. The Wasmtime host drains requests, executes each batch concurrently, delivers completions, and polls QuickJS until the program completes.

Before this can replace the Node executor, the addon still needs epoch-based wall-clock interruption, explicit component memory limits, cancellation propagation, native artifact loading, structured failure conversion, and the full `FunctionExecutor` adapter.
