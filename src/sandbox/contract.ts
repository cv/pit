export const SANDBOX_GLOBALS = `
declare const console: {
  log(...values: unknown[]): void;
  error(...values: unknown[]): void;
  warn(...values: unknown[]): void;
};
declare function setTimeout(handler: Function, timeout?: number): unknown;
declare function atob(data: string): string;
declare function btoa(data: string): string;
`;
