import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import * as ts from "typescript";

import {
  functionRegistry,
  resolveToolCatalog,
  type FunctionEnvironment,
  type FunctionDefinitionReference,
} from "../functions/environment.js";
import {
  assertGraphAvailable,
  resolveFunctionGraph,
  type ResolvedFunctionGraph,
} from "../functions/resolved-graph.js";
import { isProgramExpression } from "../functions/source.js";
import { SANDBOX_GLOBALS } from "./contract.js";
import { functionTypeModel } from "./function-types.js";

const GLOBAL_CONTRACT = readFileSync(
  fileURLToPath(new URL("../generated/global-contract.d.ts", import.meta.url)),
  "utf8",
);
const CONTRACT_FILE = "/pit/global-contract.d.ts";
const PROGRAM_FILE = "/pit/program.ts";
const SIGNATURES_FILE = "/pit/saved-signatures.ts";
const EXPRESSION_PREFIX = "const program: PitProgram = async (__pit_hostCalls) => await (\n";
const IGNORED_DIAGNOSTIC_CODES = new Set([7005, 7006, 7019, 7022, 7023, 7031, 7034, 7044]);
const MAX_DIAGNOSTICS = 8;
const SAVED_FUNCTION_HINT =
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

/**
 * Identifies one error in a saved definition's source, which is checked both as the program and
 * as its signature copy: the code, message, and source text from the error to the end of its line.
 * The copy's first line carries a prefix, so columns differ; the remaining text does not.
 */
function sourceErrorKey(diagnostic: ts.Diagnostic, file: ts.SourceFile): string {
  // TypeScript positions every diagnostic it reports in a source file.
  const position = file.getLineAndCharacterOfPosition(diagnostic.start as number);
  const rest = (file.text.split("\n")[position.line] as string).slice(position.character);
  return `${diagnostic.code}\0${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}\0${rest.trimEnd()}`;
}

/** Signature diagnostics that repeat a program diagnostic add nothing and name an internal file. */
function withoutSignatureRepeats(diagnostics: readonly ts.Diagnostic[]): ts.Diagnostic[] {
  const programErrors = new Set(
    diagnostics.flatMap((diagnostic) =>
      diagnostic.file?.fileName === PROGRAM_FILE
        ? [sourceErrorKey(diagnostic, diagnostic.file)]
        : [],
    ),
  );
  return diagnostics.filter(
    (diagnostic) =>
      diagnostic.file?.fileName !== SIGNATURES_FILE ||
      !programErrors.has(sourceErrorKey(diagnostic, diagnostic.file)),
  );
}

const MAX_INJECTION_HINTS = 3;
const MAX_SUGGESTIONS = 3;
const MAX_LISTED_METHODS = 8;
const MAX_HINT_CHARACTERS = 320;

/** Levenshtein distance, ignoring case, between two identifiers. */
function editDistance(left: string, right: string): number {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        (previous[j] as number) + 1,
        (current[j - 1] as number) + 1,
        (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length] as number;
}

/** The program's own function: the first function-like node in the wrapped program file. */
function programFunction(file: ts.SourceFile): ts.SignatureDeclaration | undefined {
  let found: ts.SignatureDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) ||
      ts.isFunctionDeclaration(node)
    ) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** The dotted injection path of the binding key at `position`, such as `tests.runTargeted`. */
function injectionPath(
  name: ts.BindingName,
  position: number,
  path: string[] = [],
): string[] | undefined {
  if (!ts.isObjectBindingPattern(name)) return undefined;
  for (const element of name.elements) {
    const key = element.propertyName ?? element.name;
    // A quoted key names the same injection; a computed one matches no function.
    const text = key.getText().replace(/^(["'])(.*)\1$/, "$2");
    if (position >= key.getStart() && position < key.end) return [...path, text];
    const inner = injectionPath(element.name, position, [...path, text]);
    if (inner) return inner;
  }
  return undefined;
}

/**
 * The name an injection error could not resolve: a destructured namespace or function in the
 * program's first parameter, or an undeclared identifier. Property errors on values the program
 * computes are not injection errors.
 */
function unresolvedInjection(diagnostic: ts.Diagnostic): string | undefined {
  const file = diagnostic.file;
  if (file?.fileName !== PROGRAM_FILE || diagnostic.start === undefined) return undefined;
  if (diagnostic.code === 2304) {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
    return /^Cannot find name '([^']+)'/.exec(message)?.[1];
  }
  if (diagnostic.code !== 2339 && diagnostic.code !== 2551) return undefined;
  const parameter = programFunction(file)?.parameters[0];
  return parameter ? injectionPath(parameter.name, diagnostic.start)?.join(".") : undefined;
}

function boundedList(items: readonly string[], limit: number): string {
  const shown = items.slice(0, limit).join(", ");
  return items.length > limit ? `${shown}, … ${items.length - limit} more` : shown;
}

/** Closest injectable names for an unresolved one, and the methods of a namespace it names. */
function injectionHint(name: string, names: readonly string[]): string {
  const segments = name.split(".");
  const leaf = segments.at(-1) as string;
  const namespace = segments.slice(0, -1).join(".");
  const namespaces = [
    ...new Set(names.flatMap((id) => (id.includes(".") ? [id.slice(0, id.lastIndexOf("."))] : []))),
  ];
  if (segments.length === 1 && (names.includes(name) || namespaces.includes(name))) {
    return `"${name}" is injectable: destructure it in the first parameter, such as ({ ${name} }).`;
  }
  const candidates = [...names, ...namespaces];
  const threshold = Math.max(2, Math.floor(leaf.length / 3));
  const ranked = candidates
    .map((id) => {
      const idLeaf = id.slice(id.lastIndexOf(".") + 1);
      return { id, distance: Math.min(editDistance(name, id), editDistance(leaf, idLeaf)) };
    })
    .filter((candidate) => candidate.distance <= threshold)
    .sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id))
    .slice(0, MAX_SUGGESTIONS)
    .map((candidate) => candidate.id);
  const methods = namespaces.includes(namespace)
    ? names.filter(
        (id) => id.startsWith(`${namespace}.`) && !id.slice(namespace.length + 1).includes("."),
      )
    : [];
  const parts = [
    ranked.length > 0
      ? `Did you mean: ${ranked.join(", ")}?`
      : `No injectable function is named "${name}"; functions.listAll() lists them.`,
    ...(methods.length > 0
      ? [
          `${namespace} has: ${boundedList(
            methods.map((id) => id.slice(namespace.length + 1)),
            MAX_LISTED_METHODS,
          )}.`,
        ]
      : []),
  ];
  const hint = parts.join(" ");
  return hint.length > MAX_HINT_CHARACTERS ? `${hint.slice(0, MAX_HINT_CHARACTERS - 1)}…` : hint;
}

function validationError(diagnostics: readonly ts.Diagnostic[], names: readonly string[]): string {
  const unique = [
    ...new Map(
      withoutSignatureRepeats(diagnostics).map((diagnostic) => [
        `${diagnostic.code}:${diagnostic.file?.fileName}:${diagnostic.start}:${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`,
        diagnostic,
      ]),
    ).values(),
  ];
  const displayed = unique.slice(0, MAX_DIAGNOSTICS);
  const messages = displayed.map(formatDiagnostic);
  const omitted = unique.length - displayed.length;
  const savedFunctionHint = diagnostics.some((diagnostic) => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
    return (
      (diagnostic.code === 2304 && message === "Cannot find name 'saved'.") ||
      (diagnostic.code === 2339 && message.startsWith("Property 'saved' does not exist on type "))
    );
  })
    ? `\n${SAVED_FUNCTION_HINT}`
    : "";
  const jsonResultHint = diagnostics.some((diagnostic) => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
    return (
      /\bPit(?:Result|Program|SourceProgram)\b/.test(message) && message.includes("PitJsonValue")
    );
  })
    ? `\n${JSON_RESULT_HINT}`
    : "";
  const injectionHints = [
    ...new Set(diagnostics.flatMap((diagnostic) => unresolvedInjection(diagnostic) ?? [])),
  ]
    .slice(0, MAX_INJECTION_HINTS)
    .map((name) => `\n${injectionHint(name, names)}`)
    .join("");
  return (
    `TypeScript validation failed:\n- ${messages.join("\n- ")}` +
    (omitted > 0 ? `\n… ${omitted} more diagnostic${omitted === 1 ? "" : "s"} omitted` : "") +
    savedFunctionHint +
    jsonResultHint +
    injectionHints
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
  const graph = structuredClone(
    validateSource(source, new Map(), input, { ...validation, requireExpression: true })
      .graph as ResolvedFunctionGraph,
  );
  // Saved functions that inject a tool Pi does not offer now are kept, but cannot run.
  assertGraphAvailable(graph);
  return graph;
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
  const environment = validation.environment ?? { sessionFunctions: savedFunctions };
  // Includes placeholders for tools saved functions inject that Pi does not offer now.
  const tools = resolveToolCatalog(environment);
  const registry = functionRegistry(environment, tools);
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
      `${GLOBAL_CONTRACT.replace("interface PitDependencies {", "interface PitGlobalFunctions {") + SANDBOX_GLOBALS}
${model.declarations}${tools?.declarations ?? ""}`,
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
