"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const executor = require("./pit_wasmtime_executor.node");

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

  let queuedPreparedResult;
  const queuedPreparedExecuted = await executor.executeQueuedJavascript(
    queuedGuest,
    prepared.source,
    async (rawRequest) => {
      const request = JSON.parse(rawRequest);
      if (request.type === "result") {
        queuedPreparedResult = request.value;
        return JSON.stringify({ value: null });
      }
      const effect = `${request.capability}.${request.method}`;
      if (effect === "context.get") {
        return JSON.stringify({ value: { cwd: "/queued", backend: "rquickjs" } });
      }
      return JSON.stringify({ value: null });
    },
  );
  assert.equal(queuedPreparedExecuted, true);
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
      restrictedWasi: true,
      preparedPitProgram: queuedPreparedExecuted,
      queuedRquickjsGuest: true,
      concurrentHostCalls: maximumActiveCalls,
    }),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
