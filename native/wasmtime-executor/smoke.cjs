"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const executor = require("./pit_wasmtime_executor.node");

async function main() {
  const guest = fs.readFileSync("./pit_javy_guest.wasm");
  const guestModule = new WebAssembly.Module(guest);
  const guestImports = WebAssembly.Module.imports(guestModule);
  assert.equal(
    guestImports.some(({ module }) => module.startsWith("wasi")),
    false,
  );

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

  let javascriptCallbackCalls = 0;
  const javascriptExecuted = await executor.executeJavascript(
    guest,
    `
      const request = JSON.stringify({ type: "increment", value: 41 });
      const response = JSON.parse(await pitCall(request));
      if (response.value !== 42) {
        throw new Error("unexpected host answer: " + response.value);
      }
    `,
    async (request) => {
      javascriptCallbackCalls++;
      const parsed = JSON.parse(request);
      await new Promise((resolve) => setTimeout(resolve, 10));
      return JSON.stringify({ value: parsed.value + 1 });
    },
  );
  assert.equal(javascriptExecuted, true);
  assert.equal(javascriptCallbackCalls, 1);

  console.log(
    JSON.stringify({
      backend: "wasmtime",
      inProcess: true,
      answer,
      fuelInterruption: true,
      wasiLinked: false,
      asyncHostCallback: true,
      quickJsGuest: javascriptExecuted,
      jsonHostBridge: true,
      guestImports,
    }),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
