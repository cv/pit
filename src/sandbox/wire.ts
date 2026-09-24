import type { FunctionExecutionContext } from "../execution/capability-trace.js";

export interface SandboxWireError {
  name?: string;
  message: string;
  frames?: string[];
  truncated?: true;
}

export interface WireMessage {
  token?: string;
  type?: string;
  id?: number;
  capability?: string;
  method?: string;
  args?: unknown[];
  functionContext?: FunctionExecutionContext;
  value?: unknown;
  error?: string | SandboxWireError;
  /** Non-default error name for a string error, such as TimeoutError or AbortError. */
  errorName?: string;
  input?: unknown;
}

export type CapabilityCallMessage = WireMessage &
  Required<Pick<WireMessage, "id" | "capability" | "method" | "args">>;

export function isCapabilityCallMessage(message: WireMessage): message is CapabilityCallMessage {
  return (
    message.type === "call" &&
    typeof message.id === "number" &&
    typeof message.capability === "string" &&
    typeof message.method === "string" &&
    Array.isArray(message.args)
  );
}

export class WireFrameDecoder {
  #buffer = "";

  constructor(private readonly maximumFrameBytes: number) {}

  push(chunk: string): WireMessage[] {
    this.#buffer += chunk;
    const messages: WireMessage[] = [];
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) {
        break;
      }
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      this.#checkSize(line);
      try {
        const value = JSON.parse(line) as unknown;
        if (value && typeof value === "object" && !Array.isArray(value)) {
          messages.push(value as WireMessage);
        }
      } catch {
        // Ignore malformed and untrusted writes to stdout.
      }
    }
    this.#checkSize(this.#buffer);
    return messages;
  }

  #checkSize(value: string): void {
    if (Buffer.byteLength(value) > this.maximumFrameBytes) {
      throw new RangeError(`RPC frame exceeds ${this.maximumFrameBytes} bytes`);
    }
  }
}
