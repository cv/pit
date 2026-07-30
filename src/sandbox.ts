import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";
import * as ts from "typescript";

export interface SandboxOptions {
  memoryLimitMb?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type CapabilityHandler = (
  capability: string,
  method: string,
  args: unknown[],
) => unknown | Promise<unknown>;

interface WireMessage {
  token?: string;
  type?: string;
  id?: number;
  capability?: string;
  method?: string;
  args?: unknown[];
  value?: unknown;
  error?: string;
}

const RUNNER = fileURLToPath(new URL("./sandbox-runner.mjs", import.meta.url));
const CAPABILITY_CONTRACT = readFileSync(
  fileURLToPath(new URL("./capability-contract.d.ts", import.meta.url)),
  "utf8",
);
const CONTRACT_FILE = "/pit/capability-contract.d.ts";
const PROGRAM_FILE = "/pit/program.ts";
const PROGRAM_PREFIX = "const program: PitProgram = (\n";
const IGNORED_DIAGNOSTIC_CODES = new Set([7005, 7006, 7019, 7031, 7034, 7044]);
const MAX_DIAGNOSTICS = 8;
const MAX_CACHE_ENTRIES = 128;
const validationCache = new Map<string, string | null>();
const compilationCache = new Map<string, Promise<string>>();
let validationCacheHits = 0;
let compilationCacheHits = 0;

function cacheSet<T>(cache: Map<string, T>, key: string, value: T): void {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > MAX_CACHE_ENTRIES) {
    cache.delete(cache.keys().next().value!);
  }
}

export function clearSandboxCaches(): void {
  validationCache.clear();
  compilationCache.clear();
  validationCacheHits = 0;
  compilationCacheHits = 0;
}

export function getSandboxCacheStats() {
  return {
    validationEntries: validationCache.size,
    compilationEntries: compilationCache.size,
    validationHits: validationCacheHits,
    compilationHits: compilationCacheHits,
  };
}
const SANDBOX_GLOBALS = `
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

export function formatDiagnostic(diagnostic: ts.Diagnostic): string {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  if (!diagnostic.file || diagnostic.start === undefined) return message;
  const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  const location = diagnostic.file.fileName !== PROGRAM_FILE
    ? `${diagnostic.file.fileName}:${position.line + 1}:${position.character + 1}`
    // Submitted source starts on line two of the wrapper, so its one-based
    // line number is equal to the wrapper's zero-based line number.
    : `${Math.max(1, position.line)}:${position.character + 1}`;
  const sourceLine = diagnostic.file.text.split("\n")[position.line];
  if (sourceLine === undefined) return `${location} ${message}`;
  const caret = " ".repeat(position.character) + "^";
  return `${location} ${message}\n  ${sourceLine}\n  ${caret}`;
}

/** Semantically validate model code against the capability contract. */
export function validateTypeScript(source: string): void {
  if (validationCache.has(source)) {
    validationCacheHits++;
    const cachedError = validationCache.get(source);
    if (cachedError) throw new Error(cachedError);
    return;
  }

  const wrapped = `${PROGRAM_PREFIX}${source}\n);\nvoid program;\n`;
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ["lib.es2022.d.ts"],
    types: [],
    strict: true,
    noImplicitAny: true,
    useUnknownInCatchVariables: false,
    noEmit: true,
    skipLibCheck: true,
  };
  const baseHost = ts.createCompilerHost(options, true);
  const sources = new Map([
    [CONTRACT_FILE, CAPABILITY_CONTRACT + SANDBOX_GLOBALS],
    [PROGRAM_FILE, wrapped],
  ]);
  const host: ts.CompilerHost = {
    ...baseHost,
    fileExists: (fileName) => sources.has(fileName) || baseHost.fileExists(fileName),
    readFile: (fileName) => sources.get(fileName) ?? baseHost.readFile(fileName),
    getSourceFile: (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
      const contents = sources.get(fileName);
      return contents === undefined
        ? baseHost.getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
        : ts.createSourceFile(fileName, contents, languageVersion, true);
    },
  };
  const program = ts.createProgram([CONTRACT_FILE, PROGRAM_FILE], options, host);
  const syntactic = program.getSyntacticDiagnostics();
  const diagnostics = (syntactic.length > 0
    ? syntactic
    : [
        ...program.getOptionsDiagnostics(),
        ...program.getGlobalDiagnostics(),
        ...program.getSemanticDiagnostics(),
      ])
    .filter((diagnostic) => !IGNORED_DIAGNOSTIC_CODES.has(diagnostic.code));
  if (diagnostics.length > 0) {
    const unique = [...new Map(diagnostics.map((diagnostic) => [
      `${diagnostic.code}:${diagnostic.file?.fileName}:${diagnostic.start}:${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`,
      diagnostic,
    ])).values()];
    const displayed = unique.slice(0, MAX_DIAGNOSTICS);
    const messages = displayed.map(formatDiagnostic);
    const omitted = unique.length - displayed.length;
    const error =
      `TypeScript validation failed:\n- ${messages.join("\n- ")}` +
      (omitted > 0 ? `\n... ${omitted} more diagnostic${omitted === 1 ? "" : "s"} omitted` : "");
    cacheSet(validationCache, source, error);
    throw new Error(error);
  }
  cacheSet(validationCache, source, null);
}

async function compileTypeScript(source: string): Promise<string> {
  const cached = compilationCache.get(source);
  if (cached) {
    compilationCacheHits++;
    return cached;
  }
  const compilation = transform(`(${source})`, {
    loader: "ts",
    target: "es2022",
    sourcemap: "inline",
  }).then((result) => result.code);
  cacheSet(compilationCache, source, compilation);
  try {
    return await compilation;
  } catch (error) {
    compilationCache.delete(source);
    throw error;
  }
}

/**
 * Run a TypeScript function expression in a fresh, permission-restricted Node
 * process. The child has no filesystem, network, subprocess, worker, addon, or
 * inherited-environment access. All useful effects go through the provided capabilities.
 */
export async function runInSandbox(
  source: string,
  handler: CapabilityHandler,
  options: SandboxOptions = {},
): Promise<unknown> {
  const memoryLimitMb = options.memoryLimitMb ?? 128;
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isFinite(memoryLimitMb) || memoryLimitMb < 16) {
    throw new Error("memoryLimitMb must be at least 16");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
    throw new Error("timeoutMs must be positive");
  }

  validateTypeScript(source);

  const compiled = await compileTypeScript(source);
  const token = randomBytes(24).toString("base64url");
  const child = spawn(
    process.execPath,
    [
      "--permission",
      `--allow-fs-read=${RUNNER}`,
      `--max-old-space-size=${Math.floor(memoryLimitMb)}`,
      RUNNER,
    ],
    {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "", NODE_NO_WARNINGS: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  return await new Promise<unknown>((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      child.kill("SIGKILL");
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => finish(new Error("TypeScript execution cancelled"));
    const timer = setTimeout(
      () => finish(new Error(`TypeScript execution timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref?.();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) return onAbort();

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-8_192);
    });
    child.on("error", (error) => finish(error));
    child.on("exit", (code, signal) => {
      if (!settled) {
        const detail = stderr.trim() || `exit ${code ?? signal}`;
        finish(new Error(`TypeScript sandbox stopped: ${detail}`));
      }
    });

    const send = (message: WireMessage) => {
      if (!settled && child.stdin.writable) {
        child.stdin.write(`${JSON.stringify({ ...message, token })}\n`);
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      while (true) {
        const newline = stdout.indexOf("\n");
        if (newline < 0) break;
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        let message: WireMessage;
        try {
          message = JSON.parse(line) as WireMessage;
        } catch {
          continue; // Ignore untrusted writes to stdout.
        }
        if (message.token !== token) continue;
        if (message.type === "result") return finish(undefined, message.value);
        if (message.type === "fatal") return finish(new Error(message.error));
        if (
          message.type === "call" &&
          typeof message.id === "number" &&
          typeof message.capability === "string" &&
          typeof message.method === "string" &&
          Array.isArray(message.args)
        ) {
          const id = message.id;
          void Promise.resolve(handler(message.capability, message.method, message.args)).then(
            (value) => send({ type: "response", id, value }),
            (error) => send({
              type: "response",
              id,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      }
    });

    send({ type: "start", value: compiled });
  });
}
