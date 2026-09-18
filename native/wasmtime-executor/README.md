# Wasmtime executor

Pit executes submitted JavaScript in-process through a platform prebuilt N-API addon, a fresh Wasmtime store, and a custom QuickJS component. Wasmtime is the default function executor on supported Linux, macOS, and Windows ARM64/x64 targets. The permission-restricted Node child remains a deprecated fallback.

Each invocation receives:

- a fresh Wasmtime store and QuickJS runtime;
- finite fuel and an epoch deadline;
- bounded linear memory, tables, and instances;
- at most 1,024 host calls in batches of at most 32;
- bounded 8 MB JSON protocol frames; and
- explicit execution-ID cancellation routed through the epoch timer.

The component imports WASI Preview 2 runtime interfaces required by Javy. The host links them to a fresh `WasiCtx` with no inherited filesystem, environment, network, arguments, or stdio.

## Queued QuickJS protocol

The guest protocol is defined in `queued-guest/wit/world.wit` and mirrored for the Wasmtime host in `wit/queued-guest.wit`. JavaScript `pitCall()` calls return pending Promises and enqueue requests. The host drains each batch, executes independent callbacks concurrently, delivers completions, and polls QuickJS until the program completes.

## Cross-platform prebuilds

`.github/workflows/wasmtime-prebuilds.yml` builds and smoke-tests native addons on Linux, macOS, and Windows ARM64/x64 runners. The QuickJS component is built once because it is platform-independent. A tagged release calls the same workflow, collects its artifacts, creates a SHA-256 manifest, and publishes everything as release assets.

Pi runs `npm install` for Git packages. `scripts/install-wasmtime.mjs` downloads only the current target's addon and the shared component, verifies their release checksums, and writes them atomically under `native/prebuilds/<target>/`. Missing assets warn and leave the deprecated Node fallback available. Set `PIT_WASMTIME_INSTALL_STRICT=1` when installation must fail instead.

## Local build and smoke test

Build Linux ARM64 artifacts on a Linux ARM64 Docker host (other release targets are built by the CI matrix):

```sh
npm run wasmtime:build
```

Build and run the bounded smoke harness:

```sh
docker build -f Dockerfile.wasmtime-smoke --target smoke -t pit-wasmtime-smoke .
docker run --rm pit-wasmtime-smoke
```

Build the interactive Pi target with the default backend:

```sh
docker build -f Dockerfile.wasmtime-smoke --target pi-smoke -t pit-wasmtime-pi .
docker run --rm -it pit-wasmtime-pi
```

The smoke harness covers fuel and epoch interruption, explicit cancellation, memory limits, restricted WASI, prepared Pit programs, concurrent Promise host calls, and the TypeScript `FunctionExecutor` adapter.
