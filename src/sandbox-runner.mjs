// This file runs in a Node process started with the permission model enabled.
// Keep it dependency-free: it is the only file the child may read.
const write = process.stdout.write.bind(process.stdout);
const parse = JSON.parse.bind(JSON);
const stringify = JSON.stringify.bind(JSON);
const pending = new Map();
const functionToString = Function.prototype.toString.call.bind(Function.prototype.toString);
const MAX_FUNCTION_DEPTH = 32;
let functionDepth = 0;
let nextId = 1;
let token;
let buffer = "";

// Agent code can use console for diagnostics without corrupting stdout RPC.
globalThis.console = new console.Console(process.stderr, process.stderr);

function send(message) {
  write(`${stringify({ ...message, token })}\n`);
}

function call(capability, method, args) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ type: "call", id, capability, method, args });
  });
}

function functionsProxy() {
  return new Proxy(Object.create(null), {
    get(_target, method) {
      if (method === "then") return undefined;
      if (method === Symbol.toStringTag) return "PitFunctionsCapability";
      if (method === "set") {
        return (name, program) => {
          if (typeof program !== "function") {
            throw new TypeError("functions.set() expects a function");
          }
          return call("functions", "set", [name, functionToString(program)]);
        };
      }
      if (method === "run") {
        return async (name, input) => {
          if (functionDepth >= MAX_FUNCTION_DEPTH) {
            throw new Error(`Saved function call depth exceeded ${MAX_FUNCTION_DEPTH}`);
          }
          const source = await call("functions", "get", [name]);
          const program = (0, eval)(`(${source})`);
          if (typeof program !== "function") {
            throw new TypeError(`Saved function ${String(name)} is not callable`);
          }
          functionDepth++;
          try {
            return await program(capabilities, input);
          } finally {
            functionDepth--;
          }
        };
      }
      if (method === "has" || method === "list" || method === "delete") {
        return (...args) => call("functions", method, args);
      }
      if (typeof method !== "string") return undefined;
      return () => Promise.reject(new Error(`Unknown functions method: ${method}`));
    },
  });
}

function capabilityProxy(capability) {
  if (capability === "functions") return functionsProxy();
  return new Proxy(Object.create(null), {
    get(_target, method) {
      if (method === "then") return undefined;
      if (method === Symbol.toStringTag) return "PitCapability";
      if (typeof method !== "string") return undefined;
      return (...args) => call(capability, method, args);
    },
  });
}

const capabilities = new Proxy(Object.create(null), {
  get(_target, capability) {
    if (capability === Symbol.toStringTag) return "PitCapabilities";
    if (typeof capability !== "string") return undefined;
    return capabilityProxy(capability);
  },
});

async function start(source) {
  try {
    // Indirect eval prevents evaluated code from seeing this module's lexical
    // token and RPC state. The OS permission layer contains its globals.
    const main = (0, eval)(source);
    if (typeof main !== "function") {
      throw new TypeError("TypeScript source must evaluate to a function");
    }
    const value = await main(capabilities);
    send({ type: "result", value });
  } catch (error) {
    send({ type: "fatal", error: error?.stack || String(error) });
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    let message;
    try {
      message = parse(line);
    } catch {
      continue;
    }
    if (!token && message.type === "start" && typeof message.token === "string") {
      token = message.token;
      void start(message.value);
      continue;
    }
    if (message.token !== token) continue;
    if (message.type === "response" && typeof message.id === "number") {
      const request = pending.get(message.id);
      if (!request) continue;
      pending.delete(message.id);
      if (typeof message.error === "string") request.reject(new Error(message.error));
      else request.resolve(message.value);
    }
  }
});
