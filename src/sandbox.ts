import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";
import * as ts from "typescript";
import {
  type CapabilityTrace,
  type FunctionExecutionContext,
  finishCapabilityTrace,
  startCapabilityTrace,
} from "./capability-trace.js";

const SIGNATURE_WHITESPACE = /\s+/g;
const JSDOC_PARAGRAPH_SEPARATOR = /\r?\n\s*\r?\n/;
const JSDOC_PARAMETER_PREFIX = /^-\s*/;

export interface SandboxOptions {
  memoryLimitMb?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  savedFunctions?: ReadonlyMap<string, string>;
  savedFunctionScopes?: ReadonlyMap<string, "project" | "session">;
  input?: unknown;
  onCapabilityTrace?: (trace: CapabilityTrace) => void;
}

export type CapabilityHandler = (
  capability: string,
  method: string,
  args: unknown[],
  signal: AbortSignal,
  functionContext?: FunctionExecutionContext,
) => unknown | Promise<unknown>;

interface WireMessage {
  token?: string;
  type?: string;
  id?: number;
  capability?: string;
  method?: string;
  args?: unknown[];
  functionContext?: FunctionExecutionContext;
  value?: unknown;
  error?: string;
  input?: unknown;
}

const RUNNER = fileURLToPath(new URL("./sandbox-runner.mjs", import.meta.url));
const CAPABILITY_CONTRACT = readFileSync(
  fileURLToPath(new URL("./capability-contract.d.ts", import.meta.url)),
  "utf8",
);
const CONTRACT_FILE = "/pit/capability-contract.d.ts";
const PROGRAM_FILE = "/pit/program.ts";
const SIGNATURES_FILE = "/pit/saved-signatures.ts";
const EXPRESSION_PREFIX = "const program: PitProgram = async (__pit_capabilities) => await (\n";
const IGNORED_DIAGNOSTIC_CODES = new Set([7005, 7006, 7019, 7022, 7023, 7031, 7034, 7044]);
const MAX_DIAGNOSTICS = 8;
const MAX_CACHE_ENTRIES = 128;
const MAX_PROTOCOL_FRAME_BYTES = 8_000_000;
const MAX_CONCURRENT_CAPABILITY_CALLS = 32;
const MAX_CAPABILITY_CALLS = 1024;
const validationCache = new Map<string, string | null>();
const compilationCache = new Map<string, Promise<string>>();
let validationCacheHits = 0;
let compilationCacheHits = 0;

function cacheSet<T>(cache: Map<string, T>, key: string, value: T): void {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > MAX_CACHE_ENTRIES) {
    // biome-ignore lint/style/noNonNullAssertion: a non-empty oversized map always has an oldest key.
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
  if (!diagnostic.file || diagnostic.start === undefined) {
    return message;
  }
  const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  const location =
    diagnostic.file.fileName === PROGRAM_FILE
      ? `${Math.max(1, position.line)}:${position.character + 1}`
      : // Submitted source starts on line two of the wrapper, so its one-based
        // line number is equal to the wrapper's zero-based line number.
        `${diagnostic.file.fileName}:${position.line + 1}:${position.character + 1}`;
  const sourceLine = diagnostic.file.text.split("\n")[position.line];
  if (sourceLine === undefined) {
    return `${location} ${message}`;
  }
  const caret = `${" ".repeat(position.character)}^`;
  return `${location} ${message}\n  ${sourceLine}\n  ${caret}`;
}

function submissionExpression(source: string): ts.Expression | undefined {
  const file = ts.createSourceFile(
    "/pit/submission.ts",
    `const __pit_submission = (${source});`,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  const statement = file.statements[0];
  if (!(statement && ts.isVariableStatement(statement))) {
    return;
  }
  let expression = statement.declarationList.declarations[0]?.initializer;
  while (expression && ts.isParenthesizedExpression(expression)) {
    expression = expression.expression;
  }
  return expression;
}

function referencedNames(source: string, candidates: ReadonlySet<string>): Set<string> {
  if (candidates.size === 0) {
    return new Set();
  }
  const contractFile = "/pit/reference-contract.d.ts";
  const sourceFile = "/pit/references.ts";
  const declarations = [...candidates]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => `declare const ${name}: (...args: unknown[]) => unknown;`)
    .join("\n");
  const wrapped = `function __pit_reference_scope() {\n${source}\n}`;
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    noLib: true,
    noResolve: true,
    skipLibCheck: true,
  };
  const baseHost = ts.createCompilerHost(options, true);
  const sources = new Map([
    [contractFile, declarations],
    [sourceFile, wrapped],
  ]);
  const host: ts.CompilerHost = {
    ...baseHost,
    fileExists: (fileName) => sources.has(fileName),
    getSourceFile: (fileName, languageVersion) =>
      // biome-ignore lint/style/noNonNullAssertion: the program requests only generated root files.
      ts.createSourceFile(fileName, sources.get(fileName)!, languageVersion, true),
  };
  const program = ts.createProgram([contractFile, sourceFile], options, host);
  const checker = program.getTypeChecker();
  // biome-ignore lint/style/noNonNullAssertion: both generated files are program roots.
  const contract = program.getSourceFile(contractFile)!;
  // biome-ignore lint/style/noNonNullAssertion: both generated files are program roots.
  const submitted = program.getSourceFile(sourceFile)!;

  const namesBySymbol = new Map<ts.Symbol, string>();
  for (const statement of contract.statements) {
    const declaration = (statement as ts.VariableStatement).declarationList.declarations[0];
    // biome-ignore lint/style/noNonNullAssertion: every generated statement has one identifier declaration.
    const identifier = declaration!.name as ts.Identifier;
    // biome-ignore lint/style/noNonNullAssertion: generated ambient declarations always bind a symbol.
    namesBySymbol.set(checker.getSymbolAtLocation(identifier)!, identifier.text);
  }

  const references = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      let ancestor: ts.Node | undefined = node;
      let typeOnly = false;
      while (ancestor && ancestor !== submitted) {
        if (ts.isTypeNode(ancestor)) {
          typeOnly = true;
          break;
        }
        ancestor = ancestor.parent;
      }
      if (!typeOnly) {
        const symbol = checker.getSymbolAtLocation(node);
        const name = symbol ? namesBySymbol.get(symbol) : undefined;
        if (name) {
          references.add(name);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(submitted);
  return references;
}

export interface SavedFunctionReference {
  name: string;
  source: string;
  direct: boolean;
}

export function resolveSavedFunctionReferences(
  source: string,
  savedFunctions: ReadonlyMap<string, string>,
): SavedFunctionReference[] {
  const names = new Set(savedFunctions.keys());
  const direct = referencedNames(source, names);
  const resolved = new Map<string, SavedFunctionReference>();
  const visiting = new Set<string>();
  const visit = (name: string, isDirect: boolean): void => {
    const savedSource = savedFunctions.get(name);
    if (savedSource === undefined || visiting.has(name)) {
      return;
    }
    const existing = resolved.get(name);
    if (existing) {
      if (isDirect) {
        existing.direct = true;
      }
      return;
    }
    visiting.add(name);
    const dependencies = [...referencedNames(savedSource, names)]
      .filter((dependency) => dependency !== name)
      .sort((a, b) => a.localeCompare(b));
    for (const dependency of dependencies) {
      visit(dependency, false);
    }
    visiting.delete(name);
    resolved.set(name, { name, source: savedSource, direct: isDirect });
  };
  for (const name of [...direct].sort((a, b) => a.localeCompare(b))) {
    visit(name, true);
  }
  return [...resolved.values()];
}

function isProgramExpression(source: string): boolean {
  const expression = submissionExpression(source);
  return Boolean(
    expression && (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)),
  );
}

export function getNamedFunctionName(source: string): string | undefined {
  const expression = submissionExpression(source);
  return expression && ts.isFunctionExpression(expression) && expression.name
    ? expression.name.text
    : undefined;
}

export interface ProjectFunctionParameter {
  name: string;
  description?: string;
}

export interface ProjectFunctionMetadata {
  name: string;
  signature: string;
  summary: string;
  parameters: ProjectFunctionParameter[];
}

function jsDocText(value: string | ts.NodeArray<ts.JSDocComment> | undefined): string {
  if (typeof value === "string") {
    return value;
  }
  if (!value) {
    return "";
  }
  return value
    .map((part) =>
      part.kind === ts.SyntaxKind.JSDocText ? (part as ts.JSDocText).text : part.getText(),
    )
    .join("");
}

function functionCallSignature(
  name: string,
  parameters: ts.NodeArray<ts.ParameterDeclaration>,
): string {
  const input = parameters[1];
  if (!input) {
    return `${name}()`;
  }
  const optional = input.questionToken || input.initializer ? "?" : "";
  const type = (input.type?.getText() ?? "unknown").replace(SIGNATURE_WHITESPACE, " ");
  return `${name}(input${optional}: ${type})`;
}

/** Extract and validate an immediately attached `@pit project` JSDoc marker. */
export function getProjectFunctionMetadata(source: string): ProjectFunctionMetadata | undefined {
  const file = ts.createSourceFile(
    "/pit/project-function.ts",
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  if (file.statements.length !== 1) {
    return;
  }
  const declaration = file.statements[0];
  if (!(declaration && ts.isFunctionDeclaration(declaration) && declaration.name)) {
    return;
  }

  const pitTags = ts.getJSDocTags(declaration).filter((tag) => tag.tagName.text === "pit");
  if (pitTags.length === 0) {
    return;
  }
  const scope = jsDocText(pitTags.at(-1)?.comment).trim();
  if (scope !== "project") {
    throw new Error(`@pit scope must have value "project"; received ${JSON.stringify(scope)}`);
  }

  const docs = (declaration as ts.FunctionDeclaration & { jsDoc: ts.JSDoc[] }).jsDoc;
  const summary =
    docs
      .map((doc) => jsDocText(doc.comment).trim().split(JSDOC_PARAGRAPH_SEPARATOR, 1)[0] as string)
      .find(Boolean) ?? "";
  if (!summary) {
    throw new Error("project functions require a JSDoc summary before @pit project");
  }

  const parameters = ts
    .getJSDocTags(declaration)
    .filter(ts.isJSDocParameterTag)
    .map((tag) => {
      const description = jsDocText(tag.comment).trim().replace(JSDOC_PARAMETER_PREFIX, "");
      return {
        name: tag.name.getText(file),
        ...(description ? { description } : {}),
      };
    });
  return {
    name: declaration.name.text,
    signature: functionCallSignature(declaration.name.text, declaration.parameters),
    summary,
    parameters,
  };
}

export function getSavedFunctionCallSignature(source: string): string | undefined {
  const expression = submissionExpression(source);
  if (!(expression && ts.isFunctionExpression(expression) && expression.name)) {
    return;
  }
  return functionCallSignature(expression.name.text, expression.parameters);
}

function savedEntries(savedFunctions: ReadonlyMap<string, string>) {
  return [...savedFunctions.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function savedDeclarations(savedFunctions: ReadonlyMap<string, string>): string {
  return savedEntries(savedFunctions)
    .map(
      ([name], index) =>
        `declare const ${name}: (input?: PitSavedInput<typeof __pit_signature_${index}>) => Promise<Awaited<ReturnType<typeof __pit_signature_${index}>>>;`,
    )
    .join("\n");
}

function savedSignatures(savedFunctions: ReadonlyMap<string, string>): string {
  const signatures = savedEntries(savedFunctions).map(
    ([, source], index) => `const __pit_signature_${index} = (${source}) satisfies PitProgram;`,
  );
  return signatures.length > 0 ? signatures.join("\n") : "void 0;";
}

/** Semantically validate model code against the capability contract. */
export function validateTypeScript(
  source: string,
  savedFunctions: ReadonlyMap<string, string> = new Map(),
  input?: unknown,
  availableNames: Iterable<string> = savedFunctions.keys(),
): void {
  const programExpression = isProgramExpression(source);
  const entries = savedEntries(savedFunctions);
  const names = [...availableNames].sort();
  const registryKey = entries.map(([name, savedSource]) => `${name}\0${savedSource}`).join("\0");
  const availableKey = names.join("\0");
  const inputSource = input === undefined ? "" : JSON.stringify(input);
  if (input !== undefined && !programExpression) {
    throw new Error("Top-level params can only be passed to a function expression");
  }
  const cacheKey = `${programExpression ? "program" : "expression"}\0${registryKey}\0${availableKey}\0${inputSource}\0${source}`;
  if (validationCache.has(cacheKey)) {
    validationCacheHits++;
    const cachedError = validationCache.get(cacheKey);
    if (cachedError) {
      throw new Error(cachedError);
    }
    return;
  }

  const invocation =
    input === undefined || !programExpression
      ? ""
      : `program({} as PitCapabilities, ${inputSource});\n`;
  const wrapped = programExpression
    ? `const program = (\n${source}\n) satisfies PitProgram;\nvoid program;\n${invocation}`
    : `${EXPRESSION_PREFIX}${source}\n);\nvoid program;\n`;
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
    [
      CONTRACT_FILE,
      `${CAPABILITY_CONTRACT + SANDBOX_GLOBALS}\n${savedDeclarations(savedFunctions)}`,
    ],
    [PROGRAM_FILE, wrapped],
    [SIGNATURES_FILE, savedSignatures(savedFunctions)],
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
  const program = ts.createProgram([CONTRACT_FILE, SIGNATURES_FILE, PROGRAM_FILE], options, host);
  const syntactic = program.getSyntacticDiagnostics();
  const diagnostics = (
    syntactic.length > 0
      ? syntactic
      : [
          ...program.getOptionsDiagnostics(),
          ...program.getGlobalDiagnostics(),
          ...program.getSemanticDiagnostics(),
        ]
  ).filter((diagnostic) => !IGNORED_DIAGNOSTIC_CODES.has(diagnostic.code));
  if (diagnostics.length > 0) {
    const unique = [
      ...new Map(
        diagnostics.map((diagnostic) => [
          `${diagnostic.code}:${diagnostic.file?.fileName}:${diagnostic.start}:${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`,
          diagnostic,
        ]),
      ).values(),
    ];
    const displayed = unique.slice(0, MAX_DIAGNOSTICS);
    const messages = displayed.map(formatDiagnostic);
    const omitted = unique.length - displayed.length;
    const savedHint =
      diagnostics.some((diagnostic) => diagnostic.code === 2304) && names.length > 0
        ? `\nAvailable saved functions: ${names.join(", ")}`
        : "";
    const error =
      `TypeScript validation failed:\n- ${messages.join("\n- ")}` +
      (omitted > 0 ? `\n... ${omitted} more diagnostic${omitted === 1 ? "" : "s"} omitted` : "") +
      savedHint;
    cacheSet(validationCache, cacheKey, error);
    throw new Error(error);
  }
  cacheSet(validationCache, cacheKey, null);
}

function runtimeProgram(
  source: string,
  savedFunctions: ReadonlyMap<string, string>,
  savedFunctionScopes: ReadonlyMap<string, "project" | "session">,
): string {
  const entries = savedEntries(savedFunctions);
  const raw = entries.map(
    ([, savedSource], index) => `const __pit_saved_${index} = (${savedSource});`,
  );
  const bound = entries.map(([name], index) => {
    const scope = savedFunctionScopes.get(name) ?? "session";
    return `const ${name} = async (__pit_input) => __pit_run_saved(${JSON.stringify(name)}, ${JSON.stringify(scope)}, async () => { await __pit_capabilities.__pit.savedFunctionRun(${JSON.stringify(name)}); try { return await __pit_saved_${index}(__pit_capabilities, __pit_input); } catch (__pit_error) { throw new Error(${JSON.stringify(`Saved function "${name}" failed: `)} + (__pit_error?.message ?? String(__pit_error)), { cause: __pit_error }); } });`;
  });
  const invocation = isProgramExpression(source)
    ? `const __pit_submission = (${source}); return await __pit_submission(__pit_capabilities, __pit_input);`
    : `return await (${source});`;
  return `async (__pit_capabilities, __pit_input, __pit_run_saved) => { ${raw.join("\n")} ${bound.join("\n")} ${invocation} }`;
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
 * Run a TypeScript expression in a fresh, permission-restricted Node
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

  const savedFunctions = options.savedFunctions ?? new Map<string, string>();
  const referenced = resolveSavedFunctionReferences(source, savedFunctions);
  const injectedFunctions = new Map(
    referenced.map((reference) => [reference.name, reference.source]),
  );
  validateTypeScript(source, injectedFunctions, options.input, savedFunctions.keys());

  const compiled = await compileTypeScript(
    runtimeProgram(source, injectedFunctions, options.savedFunctionScopes ?? new Map()),
  );
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
    let callCount = 0;
    let activeCalls = 0;
    let stdout = "";
    let stderr = "";
    const inFlight = new Set<Promise<void>>();
    const capabilityController = new AbortController();
    const capabilitySignal = options.signal
      ? AbortSignal.any([options.signal, capabilityController.signal])
      : capabilityController.signal;
    const reportCapabilityTrace = (trace: CapabilityTrace) => {
      try {
        options.onCapabilityTrace?.(trace);
      } catch {
        // Tracing is observational and must not affect capability execution.
      }
    };
    const finish = (error?: Error, value?: unknown) => {
      /* v8 ignore next -- only asynchronous child-process races call finish twice. */
      if (settled) {
        return;
      }
      settled = true;
      capabilityController.abort();
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      child.kill("SIGKILL");
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    };
    const finishAfterCalls = (error: Error | undefined, value?: unknown) => {
      void Promise.allSettled([...inFlight]).then(() => finish(error, value));
    };
    const onAbort = () => finish(new Error("TypeScript execution cancelled"));
    const timer = setTimeout(
      () => finish(new Error(`TypeScript execution timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref?.();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) {
      return onAbort();
    }

    /* v8 ignore next -- an EPIPE race is platform-dependent and handled defensively. */
    child.stdin.on("error", (error) => {
      if (!settled) {
        finish(error);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-8192);
    });
    child.on("error", (error) => finish(error));
    child.on("exit", (code, signal) => {
      if (!settled) {
        const detail = stderr.trim() || `exit ${code ?? signal}`;
        finish(new Error(`TypeScript sandbox stopped: ${detail}`));
      }
    });

    const send = (message: WireMessage): boolean => {
      if (settled || !child.stdin.writable) {
        return false;
      }
      const frame = `${JSON.stringify({ ...message, token })}\n`;
      if (Buffer.byteLength(frame) > MAX_PROTOCOL_FRAME_BYTES) {
        return false;
      }
      child.stdin.write(frame);
      return true;
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      for (;;) {
        const newline = stdout.indexOf("\n");
        if (newline < 0) {
          break;
        }
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        if (Buffer.byteLength(line) > MAX_PROTOCOL_FRAME_BYTES) {
          return finish(new Error(`RPC frame exceeds ${MAX_PROTOCOL_FRAME_BYTES} bytes`));
        }
        let message: WireMessage;
        try {
          message = JSON.parse(line) as WireMessage;
        } catch {
          continue; // Ignore untrusted writes to stdout.
        }
        if (message.token !== token) {
          continue;
        }
        if (message.type === "result") {
          return finishAfterCalls(undefined, message.value);
        }
        if (message.type === "fatal") {
          return finishAfterCalls(new Error(message.error));
        }
        /* v8 ignore next -- malformed authenticated frames are unreachable from the fixed runner. */
        if (
          message.type === "call" &&
          typeof message.id === "number" &&
          typeof message.capability === "string" &&
          typeof message.method === "string" &&
          Array.isArray(message.args)
        ) {
          const { id, capability, method, args } = message as Required<
            Pick<WireMessage, "id" | "capability" | "method" | "args">
          >;
          callCount++;
          const trace = startCapabilityTrace(
            id,
            callCount,
            capability,
            method,
            args,
            Date.now(),
            message.functionContext,
          );
          reportCapabilityTrace(trace);
          const finishTrace = (status: "succeeded" | "failed" | "rejected") => {
            reportCapabilityTrace(finishCapabilityTrace(trace, status));
          };
          if (callCount > MAX_CAPABILITY_CALLS) {
            send({
              type: "response",
              id,
              error: `RPC call limit exceeded (${MAX_CAPABILITY_CALLS})`,
            });
            finishTrace("rejected");
            continue;
          }
          if (activeCalls >= MAX_CONCURRENT_CAPABILITY_CALLS) {
            send({
              type: "response",
              id,
              error: `Concurrent RPC call limit exceeded (${MAX_CONCURRENT_CAPABILITY_CALLS})`,
            });
            finishTrace("rejected");
            continue;
          }
          activeCalls++;
          let task: Promise<void>;
          task = Promise.resolve()
            .then(() => handler(capability, method, args, capabilitySignal, trace.function))
            .then(
              (value) => {
                if (!send({ type: "response", id, value })) {
                  send({ type: "response", id, error: "Capability response exceeds RPC limit" });
                  finishTrace("failed");
                } else {
                  finishTrace("succeeded");
                }
              },
              (error) => {
                send({
                  type: "response",
                  id,
                  error: error instanceof Error ? error.message : String(error),
                });
                finishTrace("failed");
              },
            )
            .finally(() => {
              activeCalls--;
              inFlight.delete(task);
            });
          inFlight.add(task);
        }
      }
      /* v8 ignore next -- oversized newline-terminated frames are rejected above. */
      if (Buffer.byteLength(stdout) > MAX_PROTOCOL_FRAME_BYTES) {
        finish(new Error(`RPC frame exceeds ${MAX_PROTOCOL_FRAME_BYTES} bytes`));
      }
    });

    /* v8 ignore next -- validated source and registry limits keep start frames below the cap. */
    if (!send({ type: "start", value: compiled, input: options.input })) {
      finish(new Error(`RPC frame exceeds ${MAX_PROTOCOL_FRAME_BYTES} bytes`));
    }
  });
}
