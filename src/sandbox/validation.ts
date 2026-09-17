import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import * as ts from "typescript";

import { isProgramExpression } from "../functions/source.js";
import { SANDBOX_GLOBALS } from "./contract.js";

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
  'There is no "saved" capability. Use async ({ functions }) => functions.listAll() to inspect saved functions; invoke one directly by name.';
const MAX_CACHE_ENTRIES = 128;
const validationCache = new Map<string, string | null>();
let validationCacheHits = 0;

function cacheSet(key: string, value: string | null): void {
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

function injectedDependencyDeclarations(savedFunctions: ReadonlyMap<string, string>): string {
  const properties: string[] = [];
  for (const [name] of savedEntries(savedFunctions)) {
    if (!name.includes(".")) {
      const index = savedEntries(savedFunctions).findIndex(([candidate]) => candidate === name);
      properties.push(
        `${JSON.stringify(name)}: PitInjectedFunction<typeof __pit_signature_${index}>;`,
      );
    }
  }
  if (properties.length === 0) return "";
  return `type PitInjectedArguments<T extends (...args: any[]) => any> = Parameters<T> extends [any, ...infer Rest] ? Rest : [];
type PitInjectedFunction<T extends (...args: any[]) => any> = (...args: PitInjectedArguments<T>) => Promise<Awaited<ReturnType<T>>>;
interface PitCapabilities { ${properties.join(" ")} }`;
}

function savedSignatures(savedFunctions: ReadonlyMap<string, string>): string {
  const signatures = savedEntries(savedFunctions).map(
    ([, source], index) => `const __pit_signature_${index} = (${source}) satisfies PitProgram;`,
  );
  return signatures.length > 0 ? signatures.join("\n") : "void 0;";
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
      (diagnostic.code === 2339 &&
        message === "Property 'saved' does not exist on type 'PitCapabilities'.")
    );
  })
    ? `\n${SAVED_CAPABILITY_HINT}`
    : "";
  const savedHint =
    diagnostics.some((diagnostic) => diagnostic.code === 2304) && names.length > 0
      ? `\nAvailable saved functions: ${names.join(", ")}`
      : "";
  return (
    `TypeScript validation failed:\n- ${messages.join("\n- ")}` +
    (omitted > 0 ? `\n... ${omitted} more diagnostic${omitted === 1 ? "" : "s"} omitted` : "") +
    savedCapabilityHint +
    savedHint
  );
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
      `${CAPABILITY_CONTRACT + SANDBOX_GLOBALS}
${savedDeclarations(savedFunctions)}
${injectedDependencyDeclarations(savedFunctions)}`,
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
  const diagnostics = programDiagnostics(program);
  if (diagnostics.length > 0) {
    const error = validationError(diagnostics, names);
    cacheSet(cacheKey, error);
    throw new Error(error);
  }
  cacheSet(cacheKey, null);
}
