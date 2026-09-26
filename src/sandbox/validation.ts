import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import * as ts from "typescript";

import {
  functionRegistry,
  type FunctionEnvironment,
  type FunctionDefinitionReference,
} from "../functions/environment.js";
import { resolveFunctionGraph, type ResolvedFunctionGraph } from "../functions/resolved-graph.js";
import { isProgramExpression } from "../functions/source.js";
import { SANDBOX_GLOBALS } from "./contract.js";
import { functionTypeModel } from "./function-types.js";

const CAPABILITY_CONTRACT = readFileSync(
  fileURLToPath(new URL("../generated/capability-contract.d.ts", import.meta.url)),
  "utf8",
);
const CONTRACT_FILE = "/pit/capability-contract.d.ts";
const PROGRAM_FILE = "/pit/program.ts";
const SIGNATURES_FILE = "/pit/saved-signatures.ts";
const EXPRESSION_PREFIX = "const program: PitProgram = async (__pit_capabilities) => await (\n";
const IGNORED_DIAGNOSTIC_CODES = new Set([7005, 7006, 7019, 7022, 7023, 7031, 7034, 7044]);
const MAX_DIAGNOSTICS = 8;
const SAVED_CAPABILITY_HINT =
  'There is no "saved" namespace. Use async ({ functions: { listAll } }) => listAll() to inspect functions; inject a callable by name in the first parameter.';
// A non-JSON result fails as a long PitResult or PitProgram assignability chain that never says
// how to fix it.
const JSON_RESULT_HINT =
  "A program's result must be JSON: give the returned value concrete types instead of `unknown` or `Record<string, unknown>`, or assert a value you know is JSON with `as PitJsonValue`.";
const MAX_CACHE_ENTRIES = 128;
interface ValidatedSource {
  error?: string;
  graph?: ResolvedFunctionGraph;
}
const validationCache = new Map<string, ValidatedSource>();
let validationCacheHits = 0;

function cacheSet(key: string, value: ValidatedSource): void {
  validationCache.delete(key);
  validationCache.set(key, value);
  if (validationCache.size > MAX_CACHE_ENTRIES) {
    // oxlint-disable-next-line typescript/no-non-null-assertion
    validationCache.delete(validationCache.keys().next().value!);
  }
}

export function clearValidationCache(): void {
  validationCache.clear();
  validationCacheHits = 0;
}

export function getValidationCacheStats() {
  return {
    validationEntries: validationCache.size,
    validationHits: validationCacheHits,
  };
}

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

function programDiagnostics(program: ts.Program): readonly ts.Diagnostic[] {
  const syntactic = program.getSyntacticDiagnostics();
  const diagnostics =
    syntactic.length > 0
      ? syntactic
      : [
          ...program.getOptionsDiagnostics(),
          ...program.getGlobalDiagnostics(),
          ...program.getSemanticDiagnostics(),
        ];
  return diagnostics.filter((diagnostic) => !IGNORED_DIAGNOSTIC_CODES.has(diagnostic.code));
}

function validationError(diagnostics: readonly ts.Diagnostic[], names: readonly string[]): string {
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
  const savedCapabilityHint = diagnostics.some((diagnostic) => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
    return (
      (diagnostic.code === 2304 && message === "Cannot find name 'saved'.") ||
      (diagnostic.code === 2339 && message.startsWith("Property 'saved' does not exist on type "))
    );
  })
    ? `\n${SAVED_CAPABILITY_HINT}`
    : "";
  const jsonResultHint = diagnostics.some((diagnostic) => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
    return (
      /\bPit(?:Result|Program|SourceProgram)\b/.test(message) && message.includes("PitJsonValue")
    );
  })
    ? `\n${JSON_RESULT_HINT}`
    : "";
  const savedHint =
    diagnostics.some((diagnostic) => diagnostic.code === 2304 || diagnostic.code === 2339) &&
    names.length > 0
      ? `\nAvailable functions: ${names.join(", ")}`
      : "";
  return (
    `TypeScript validation failed:\n- ${messages.join("\n- ")}` +
    (omitted > 0 ? `\n… ${omitted} more diagnostic${omitted === 1 ? "" : "s"} omitted` : "") +
    savedCapabilityHint +
    jsonResultHint +
    savedHint
  );
}

export interface TypeScriptValidationOptions {
  environment?: FunctionEnvironment;
  definition?: FunctionDefinitionReference;
  checkAll?: boolean;
  availableNames?: Iterable<string>;
}

/** Semantically validate a submission and its concrete layered source definitions. */
export function validateTypeScript(
  source: string,
  savedFunctions: ReadonlyMap<string, string> = new Map(),
  input?: unknown,
  validation: TypeScriptValidationOptions = {},
): void {
  validateSource(source, savedFunctions, input, validation);
}

/** Execution consumes the exact graph whose layered dependencies passed validation. */
export function validateSandboxTypeScript(
  source: string,
  input: unknown,
  validation: TypeScriptValidationOptions & { environment: FunctionEnvironment },
): ResolvedFunctionGraph {
  // A supplied environment always produces a graph; callers never receive the cached graph.
  return structuredClone(
    validateSource(source, new Map(), input, { ...validation, requireExpression: true })
      .graph as ResolvedFunctionGraph,
  );
}

function validateSource(
  source: string,
  savedFunctions: ReadonlyMap<string, string>,
  input: unknown,
  validation: TypeScriptValidationOptions & { requireExpression?: boolean },
): ValidatedSource {
  const programExpression = isProgramExpression(source);
  if (validation.requireExpression && !programExpression) {
    throw new Error("TypeScript programs must be function expressions");
  }
  const registry = functionRegistry(validation.environment ?? { sessionFunctions: savedFunctions });
  const names = [
    ...(validation.availableNames ??
      (validation.environment ? registry.identifiers() : savedFunctions.keys())),
  ].sort();
  const registryKey = JSON.stringify(registry.definitions());
  const availableKey = names.join("\0");
  const inputSource = input === undefined ? "" : JSON.stringify(input);
  if (input !== undefined && !programExpression) {
    throw new Error("Top-level params can only be passed to a function expression");
  }
  const cacheKey = JSON.stringify([
    programExpression,
    registryKey,
    availableKey,
    inputSource,
    source,
    validation.definition,
    validation.checkAll,
    Boolean(validation.environment),
    [...(validation.environment?.invalidDefinitions ?? [])],
  ]);
  const cached = validationCache.get(cacheKey);
  if (cached) {
    validationCacheHits++;
    if (cached.error) throw new Error(cached.error);
    return cached;
  }

  const model = functionTypeModel(source, registry, {
    ...validation,
    checkAll: validation.checkAll ?? true,
    checkCompatibility: Boolean(validation.environment),
  });
  const rootType = validation.definition
    ? `PitSourceProgram<${model.rootDependencies}>`
    : "PitProgram";

  const invocation =
    input === undefined || !programExpression
      ? ""
      : `program({} as ${model.rootDependencies}, ${inputSource});\n`;
  const wrapped = programExpression
    ? `const program = (\n${source}\n ) satisfies ${rootType};\nvoid program;\n${invocation}`
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
      `${CAPABILITY_CONTRACT.replaceAll("PitCapabilities", "PitBuiltinCapabilities").replace("capabilities: PitBuiltinCapabilities", "capabilities: PitCapabilities") + SANDBOX_GLOBALS}
${model.declarations}`,
    ],
    [PROGRAM_FILE, wrapped],
    [SIGNATURES_FILE, model.signatures],
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
  const diagnostics = programDiagnostics(program);
  if (diagnostics.length > 0) {
    const error = validationError(diagnostics, names);
    cacheSet(cacheKey, { error });
    throw new Error(error);
  }
  const result: ValidatedSource = validation.environment
    ? {
        graph: resolveFunctionGraph(source, registry, { ...validation, ...validation.environment }),
      }
    : {};
  cacheSet(cacheKey, result);
  return result;
}
