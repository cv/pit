export const SANDBOX_GLOBALS = `
declare const console: {
  log(...values: unknown[]): void;
  error(...values: unknown[]): void;
  warn(...values: unknown[]): void;
};
declare function setTimeout(handler: Function, timeout?: number): unknown;
declare const process: {
  readonly env: Record<string, string | undefined>;
  readonly stdout: { write(chunk: string): boolean };
  readonly pid: number;
  exit(code?: number): never;
  kill(pid: number, signal?: string): boolean;
  getBuiltinModule(name: string): any;
};
`;
