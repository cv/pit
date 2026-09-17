export interface WasmtimeInstallOptions {
  root?: string;
  version?: string;
  platform?: NodeJS.Platform;
  architecture?: string;
  environment?: Record<string, string | undefined>;
  fetchAsset?: (url: string, init?: RequestInit) => Promise<Response>;
  warn?: (message: string) => void;
}

export type WasmtimeInstallResult =
  | { status: "skipped"; reason: string }
  | { status: "fallback"; target: string }
  | {
      status: "existing" | "downloaded";
      target: string;
      addonPath: string;
      componentPath: string;
    };

export function installWasmtime(options?: WasmtimeInstallOptions): Promise<WasmtimeInstallResult>;
