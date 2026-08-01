import { AsyncLocalStorage } from "node:async_hooks";

// This file runs in a Node process started with the permission model enabled.
// Keep it dependency-free: it is the only file the child may read.
const write = process.stdout.write.bind(process.stdout);
const parse = JSON.parse.bind(JSON);
const stringify = JSON.stringify.bind(JSON);
const pending = new Map();
const idleWaiters = new Set();
const MAX_PROTOCOL_FRAME_BYTES = 8_000_000;
const MAX_CONCURRENT_CALLS = 64;
const MAX_CALLS = 2048;
let nextId = 1;
let callCount = 0;
let token;
let buffer = "";
let finishing = false;
const functionContexts = new AsyncLocalStorage();
let nextInvocationId = 1;

// Agent code can use console for diagnostics without corrupting stdout RPC.
globalThis.console = new console.Console(process.stderr, process.stderr);

function send(message) {
  const frame = `${stringify({ ...message, token })}\n`;
  if (Buffer.byteLength(frame) > MAX_PROTOCOL_FRAME_BYTES) {
    throw new RangeError(`RPC frame exceeds ${MAX_PROTOCOL_FRAME_BYTES} bytes`);
  }
  write(frame);
}

function rejectedCall(message) {
  const promise = Promise.reject(new Error(message));
  void promise.catch(() => undefined);
  return promise;
}

function notifyIdle() {
  if (pending.size > 0) {
    return;
  }
  for (const resolve of idleWaiters) {
    resolve();
  }
  idleWaiters.clear();
}

function waitForPendingCalls() {
  if (pending.size === 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => idleWaiters.add(resolve));
}

function call(capability, method, args) {
  if (finishing) {
    return rejectedCall("Program has already finished");
  }
  if (callCount >= MAX_CALLS) {
    return rejectedCall(`RPC call limit exceeded (${MAX_CALLS})`);
  }
  if (pending.size >= MAX_CONCURRENT_CALLS) {
    return rejectedCall(`Concurrent RPC call limit exceeded (${MAX_CONCURRENT_CALLS})`);
  }
  callCount++;
  const id = nextId++;
  const promise = new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      const functionContext = functionContexts.getStore();
      send({
        type: "call",
        id,
        capability,
        method,
        args,
        ...(functionContext ? { functionContext } : {}),
      });
    } catch (error) {
      pending.delete(id);
      reject(error);
      notifyIdle();
    }
  });
  void promise.catch(() => undefined);
  return promise;
}

function capabilityProxy(capability) {
  return new Proxy(Object.create(null), {
    get(_target, method) {
      if (method === "then") {
        return;
      }
      if (method === Symbol.toStringTag) {
        return "PitCapability";
      }
      if (typeof method !== "string") {
        return;
      }
      return (...args) => call(capability, method, args);
    },
  });
}

const capabilities = new Proxy(Object.create(null), {
  get(_target, capability) {
    if (capability === Symbol.toStringTag) {
      return "PitCapabilities";
    }
    if (typeof capability !== "string") {
      return;
    }
    return capabilityProxy(capability);
  },
});

async function runSavedFunction(name, scope, callback) {
  const parent = functionContexts.getStore();
  const depth = (parent?.depth ?? 0) + 1;
  if (depth > 32) {
    throw new Error("Saved function call depth exceeded 32");
  }
  const context = {
    invocationId: nextInvocationId++,
    ...(parent ? { parentInvocationId: parent.invocationId } : {}),
    name,
    scope,
    depth,
  };
  return await functionContexts.run(context, callback);
}

async function start(source, input) {
  try {
    // Indirect eval prevents evaluated code from seeing this module's lexical
    // token and RPC state. The OS permission layer contains its globals.
    const main = (0, eval)(source);
    if (typeof main !== "function") {
      throw new TypeError("TypeScript source must evaluate to a function");
    }
    const value = await main(capabilities, input, runSavedFunction);
    finishing = true;
    await waitForPendingCalls();
    send({ type: "result", value });
  } catch (error) {
    finishing = true;
    try {
      await waitForPendingCalls();
      send({ type: "fatal", error: error?.stack || String(error) });
    } catch (fatalError) {
      send({ type: "fatal", error: fatalError?.stack || String(fatalError) });
    }
  }
}

function failProtocol(message) {
  finishing = true;
  process.stdin.pause();
  if (token) {
    try {
      send({ type: "fatal", error: message });
    } catch {
      process.exit(1);
    }
  } else {
    process.exit(1);
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) {
      break;
    }
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (Buffer.byteLength(line) > MAX_PROTOCOL_FRAME_BYTES) {
      failProtocol(`RPC frame exceeds ${MAX_PROTOCOL_FRAME_BYTES} bytes`);
      return;
    }
    let message;
    try {
      message = parse(line);
    } catch {
      continue;
    }
    if (!token && message.type === "start" && typeof message.token === "string") {
      token = message.token;
      void start(message.value, message.input);
      continue;
    }
    if (message.token !== token) {
      continue;
    }
    if (message.type === "response" && typeof message.id === "number") {
      const request = pending.get(message.id);
      if (!request) {
        continue;
      }
      pending.delete(message.id);
      if (typeof message.error === "string") {
        request.reject(new Error(message.error));
      } else {
        request.resolve(message.value);
      }
      notifyIdle();
    }
  }
  if (Buffer.byteLength(buffer) > MAX_PROTOCOL_FRAME_BYTES) {
    failProtocol(`RPC frame exceeds ${MAX_PROTOCOL_FRAME_BYTES} bytes`);
  }
});
