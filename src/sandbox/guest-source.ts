import type { PreparedSandboxProgram } from "./program.js";

/**
 * Globals of the codemode sandbox that Pit programs must not see: its output helpers, its store,
 * its tool table, and Pit's raw bridge. The program is compiled inside a function whose
 * parameters shadow them, so it sees standard language globals plus `console` and `setTimeout`.
 */
const SHADOWED_GLOBALS = [
  "console",
  "pitCall",
  "text",
  "image",
  "exit",
  "store",
  "load",
  "tools",
  "ALL_TOOLS",
];

/**
 * The script the sandbox runs: it binds the compiled program to Pit's queued `pitCall()` bridge,
 * runs it with the supplied input, and reports its result through the bridge.
 */
export function createGuestSource(program: PreparedSandboxProgram, input: unknown): string {
  const compiled = JSON.stringify(program.compiled);
  const serializedInput = JSON.stringify(input) ?? "undefined";
  return `
const __pit_call = pitCall;
let __pit_next_id = 1;
let __pit_next_invocation_id = 1;

// Console output is discarded: the sandbox's own console is not configurable, so the program
// gets this one through a shadowing parameter.
const __pit_console = Object.freeze({ log() {}, warn() {}, error() {} });

globalThis.setTimeout = (handler, timeout = 0, ...args) => {
  if (typeof handler !== "function") throw new TypeError("setTimeout handler must be a function");
  const requested = Number(timeout);
  const delayMs = Number.isFinite(requested) ? Math.max(0, Math.floor(requested)) : 0;
  const timer = __pit_call(JSON.stringify({ type: "timer", delayMs }));
  void timer.then(() => handler(...args));
  return timer;
};

const __pit_rpc = async (message) => {
  const response = JSON.parse(await __pit_call(JSON.stringify(message)));
  if (typeof response.error === "string") {
    const error = new Error(response.error);
    if (typeof response.errorName === "string") error.name = response.errorName;
    throw error;
  }
  return response.value;
};

// Host calls are bound to the calling saved-function invocation, if any. QuickJS has no async
// context tracking, so attribution travels explicitly instead of through shared state.
const __pit_hostCalls = (context) => new Proxy(Object.create(null), {
  get(_target, namespace) {
    if (namespace === Symbol.toStringTag) return "PitFunctions";
    if (typeof namespace !== "string") return undefined;
    return new Proxy(Object.create(null), {
      get(_namespace, method) {
        if (method === "then") return undefined;
        if (method === Symbol.toStringTag) return "PitFunctionNamespace";
        if (typeof method !== "string") return undefined;
        return (...args) => __pit_rpc({
          type: "call",
          id: __pit_next_id++,
          namespace,
          method,
          args,
          ...(context ? { functionContext: context } : {}),
        });
      },
    });
  },
});

const __pit_run_saved = async (name, scope, parent, callback) => {
  const depth = (parent?.depth ?? 0) + 1;
  if (depth > 32) throw new Error("Function call depth exceeded 32");
  return callback({
    invocationId: __pit_next_invocation_id++,
    ...(parent ? { parentInvocationId: parent.invocationId } : {}),
    name,
    scope,
    depth,
  });
};

// Direct eval inside the function evaluates the program where the parameters shadow the globals.
// Parameters without an argument, all but console, shadow their globals as undefined.
const __pit_main = new Function(
  "__pit_source",
  ...${JSON.stringify(SHADOWED_GLOBALS)},
  "return eval(__pit_source);",
)(${compiled}, __pit_console);
// A thrown error reaches the host through the sandbox's result, with its name and message.
const __pit_value = await __pit_main(__pit_hostCalls, ${serializedInput}, __pit_run_saved);
await __pit_rpc({ type: "result", value: __pit_value });
`;
}
