"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const executor = require("./pit_wasmtime_executor.node");
const { createWasmtimeFunctionExecutor } = require("./wasmtime-adapter.cjs");

async function main() {
  const answer = executor.executeWat(`
    (module
      (func (export "run") (result i32)
        i32.const 42))
  `);
  assert.equal(answer, 42);

  assert.throws(
    () =>
      executor.executeWat(
        `
          (module
            (func (export "run") (result i32)
              (loop $forever
                br $forever)
              i32.const 0))
        `,
        1_000,
      ),
    /fuel|out of fuel/i,
  );

  assert.throws(
    () =>
      executor.executeWat(`
        (module
          (import "wasi_snapshot_preview1" "fd_write" (func $fd_write))
          (func (export "run") (result i32)
            i32.const 0))
      `),
    /import|wasi_snapshot_preview1/i,
  );

  const prepared = JSON.parse(fs.readFileSync("./prepared-program.json", "utf8"));
  const queuedGuest = fs.readFileSync("./pit_queued_quickjs_guest.wasm");
  let activeCalls = 0;
  let maximumActiveCalls = 0;
  const concurrentExecuted = await executor.executeQueuedJavascript(
    queuedGuest,
    `
      const requests = [1, 2].map((value) =>
        pitCall(JSON.stringify({ type: "increment", value })),
      );
      const responses = await Promise.all(requests);
      const values = responses.map((response) => JSON.parse(response).value);
      if (values[0] !== 2 || values[1] !== 3) {
        throw new Error("unexpected concurrent values: " + values.join(","));
      }
    `,
    async (rawRequest) => {
      activeCalls++;
      maximumActiveCalls = Math.max(maximumActiveCalls, activeCalls);
      const request = JSON.parse(rawRequest);
      await new Promise((resolve) => setTimeout(resolve, 25));
      activeCalls--;
      return JSON.stringify({ value: request.value + 1 });
    },
  );
  assert.equal(concurrentExecuted, true);
  assert.equal(maximumActiveCalls, 2);

  await assert.rejects(
    executor.executeQueuedJavascript(
      queuedGuest,
      `while (true) {}`,
      async () => JSON.stringify({ value: null }),
      4_000_000_000,
      25,
      64,
    ),
    /epoch|interrupt|deadline/i,
  );

  const cancellationId = "smoke-cancellation";
  const cancelled = executor.executeQueuedJavascript(
    queuedGuest,
    `await pitCall(JSON.stringify({ type: "cancel" }));`,
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return JSON.stringify({ value: null });
    },
    4_000_000_000,
    30_000,
    64,
    cancellationId,
  );
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(executor.interruptQueuedJavascript(cancellationId), false);
  await assert.rejects(cancelled, /epoch|interrupt|deadline/i);

  await assert.rejects(
    executor.executeQueuedJavascript(
      queuedGuest,
      `const oversized = new Uint8Array(128 * 1024 * 1024); void oversized;`,
      async () => JSON.stringify({ value: null }),
      4_000_000_000,
      30_000,
      32,
    ),
    /memory|allocation|limit|grow/i,
  );

  const functionExecutor = createWasmtimeFunctionExecutor({
    addon: executor,
    component: queuedGuest,
  });
  const queuedPreparedResult = await functionExecutor.execute(
    prepared.program,
    async ({ capability, method }) => {
      const effect = `${capability}.${method}`;
      if (effect === "context.get") {
        return { cwd: "/queued", backend: "rquickjs" };
      }
      return null;
    },
    { memoryLimitMb: 64, timeoutMs: 30_000, input: { value: 42 } },
  );
  assert.deepEqual(queuedPreparedResult, {
    context: { cwd: "/queued", backend: "rquickjs" },
    input: { value: 42 },
  });

  console.log(
    JSON.stringify({
      backend: "wasmtime",
      inProcess: true,
      answer,
      fuelInterruption: true,
      epochInterruption: true,
      explicitCancellation: true,
      memoryLimit: true,
      restrictedWasi: true,
      preparedPitProgram: true,
      functionExecutorAdapter: true,
      queuedRquickjsGuest: true,
      concurrentHostCalls: maximumActiveCalls,
    }),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
