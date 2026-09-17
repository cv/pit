import type { PreparedSandboxProgram } from "./program.js";

export function createWasmtimeGuestSource(program: PreparedSandboxProgram, input: unknown): string {
  const compiled = JSON.stringify(program.compiled);
  const serializedInput = JSON.stringify(input) ?? "undefined";
  return `
let __pit_next_id = 1;
let __pit_next_invocation_id = 1;
let __pit_function_context;

globalThis.setTimeout = (handler, timeout = 0, ...args) => {
  if (typeof handler !== "function") throw new TypeError("setTimeout handler must be a function");
  const requested = Number(timeout);
  const delayMs = Number.isFinite(requested) ? Math.max(0, Math.floor(requested)) : 0;
  const timer = pitCall(JSON.stringify({ type: "timer", delayMs }));
  void timer.then(() => handler(...args));
  return timer;
};

const __pit_rpc = async (message) => {
  const response = JSON.parse(await pitCall(JSON.stringify({
    ...message,
    ...(message.type === "call" && __pit_function_context
      ? { functionContext: __pit_function_context }
      : {}),
  })));
  if (typeof response.error === "string") throw new Error(response.error);
  return response.value;
};

const __pit_capabilities = new Proxy(Object.create(null), {
  get(_target, capability) {
    if (capability === Symbol.toStringTag) return "PitFunctions";
    if (typeof capability !== "string") return undefined;
    return new Proxy(Object.create(null), {
      get(_capability, method) {
        if (method === "then") return undefined;
        if (method === Symbol.toStringTag) return "PitFunctionNamespace";
        if (typeof method !== "string") return undefined;
        return (...args) => __pit_rpc({
          type: "call",
          id: __pit_next_id++,
          capability,
          method,
          args,
        });
      },
    });
  },
});

const __pit_run_saved = async (name, scope, callback) => {
  const parent = __pit_function_context;
  const depth = (parent?.depth ?? 0) + 1;
  if (depth > 32) throw new Error("Function call depth exceeded 32");
  const context = {
    invocationId: __pit_next_invocation_id++,
    ...(parent ? { parentInvocationId: parent.invocationId } : {}),
    name,
    scope,
    depth,
  };
  __pit_function_context = context;
  try {
    await __pit_rpc({
      type: "call",
      id: __pit_next_id++,
      capability: "__pit",
      method: "savedFunctionRun",
      args: [name],
    });
    return await callback();
  } finally {
    __pit_function_context = parent;
  }
};

const __pit_main = (0, eval)(${compiled});
const __pit_value = await __pit_main(
  __pit_capabilities,
  ${serializedInput},
  __pit_run_saved,
);
await __pit_rpc({ type: "result", value: __pit_value });
`;
}
