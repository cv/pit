"use strict";

const assert = require("node:assert/strict");
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

  let callbackCalls = 0;
  const asyncAnswer = await executor.executeAsyncHost(
    `
      (module
        (import "pit" "call" (func $call (param i32) (result i32)))
        (func (export "run") (result i32)
          i32.const 41
          call $call))
    `,
    async (value) => {
      callbackCalls++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return value + 1;
    },
  );
  assert.equal(asyncAnswer, 42);
  assert.equal(callbackCalls, 1);

  console.log(
    JSON.stringify({
      backend: "wasmtime",
      inProcess: true,
      answer,
      fuelInterruption: true,
      wasiLinked: false,
      asyncHostCallback: true,
    }),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
