import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { transform } from "esbuild";
import * as ts from "typescript";

import { SANDBOX_GLOBALS } from "./sandbox-contract.js";
import {
  clearSavedFunctionDependencyGraphCache,
  getSavedFunctionDependencyGraphCacheStats,
  resolveSavedFunctionReferences,
} from "./saved-function-graph.js";
import type { FunctionScope } from "./saved-functions.js";
import { scopedRuntimeProgram, type ScopedFunctionRegistries } from "./scoped-function-runtime.js";

const SIGNATURE_WHITESPACE = /\s+/g;
const JSDOC_PARAGRAPH_SEPARATOR = /\r?\n\s*\r?\n/;
const JSDOC_PARAMETER_PREFIX = /^-\s*/;

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
const SAVED_CAPABILITY_HINT =
  'There is no "saved" capability. Use async ({ functions }) => functions.listAll() to inspect saved functions; invoke one directly by name.';
const MAX_CACHE_ENTRIES = 128;
const validationCache = new Map<string, string | null>();
const compilationCache = new Map<string, Promise<string>>();
let validationCacheHits = 0;
let compilationCacheHits = 0;

function cacheSet<T>(cache: Map<string, T>, key: string, value: T): void {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > MAX_CACHE_ENTRIES) {
    // oxlint-disable-next-line typescript/no-non-null-assertion
    cache.delete(cache.keys().next().value!);
  }
}

export function clearSandboxCaches(): void {
  validationCache.clear();
  compilationCache.clear();
  clearSavedFunctionDependencyGraphCache();
  validationCacheHits = 0;
  compilationCacheHits = 0;
}

export function getSandboxCacheStats() {
  return {
    validationEntries: validationCache.size,
    compilationEntries: compilationCache.size,
    validationHits: validationCacheHits,
    compilationHits: compilationCacheHits,
    ...getSavedFunctionDependencyGraphCacheStats(),
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

function getPersistentFunctionMetadata(
  source: string,
  expectedScope: "global" | "project",
): ProjectFunctionMetadata | undefined {
  const file = ts.createSourceFile(
    `/pit/${expectedScope}-function.ts`,
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
  if (scope !== expectedScope) {
    throw new Error(
      `@pit scope must have value ${JSON.stringify(expectedScope)}; received ${JSON.stringify(scope)}`,
    );
  }

  const docs = (declaration as ts.FunctionDeclaration & { jsDoc: ts.JSDoc[] }).jsDoc;
  const summary =
    docs
      .map((doc) => jsDocText(doc.comment).trim().split(JSDOC_PARAGRAPH_SEPARATOR, 1)[0] as string)
      .find(Boolean) ?? "";
  if (!summary) {
    throw new Error(
      `${expectedScope} functions require a JSDoc summary before @pit ${expectedScope}`,
    );
  }

  const parameters = ts
    .getJSDocTags(declaration)
    .filter(ts.isJSDocParameterTag)
    .map((tag) => {
      const description = jsDocText(tag.comment).trim().replace(JSDOC_PARAMETER_PREFIX, "");
      const parameter: ProjectFunctionParameter = { name: tag.name.getText(file) };
      if (description) {
        parameter.description = description;
      }
      return parameter;
    });
  return {
    name: declaration.name.text,
    signature: functionCallSignature(declaration.name.text, declaration.parameters),
    summary,
    parameters,
  };
}

/** Extract and validate an immediately attached `@pit project` JSDoc marker. */
export function getProjectFunctionMetadata(source: string): ProjectFunctionMetadata | undefined {
  return getPersistentFunctionMetadata(source, "project");
}

/** Extract and validate an immediately attached `@pit global` JSDoc marker. */
export function getGlobalFunctionMetadata(source: string): ProjectFunctionMetadata | undefined {
  return getPersistentFunctionMetadata(source, "global");
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
    const error =
      `TypeScript validation failed:\n- ${messages.join("\n- ")}` +
      (omitted > 0 ? `\n... ${omitted} more diagnostic${omitted === 1 ? "" : "s"} omitted` : "") +
      savedCapabilityHint +
      savedHint;
    cacheSet(validationCache, cacheKey, error);
    throw new Error(error);
  }
  cacheSet(validationCache, cacheKey, null);
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

export interface SandboxProgramOptions {
  savedFunctions?: ReadonlyMap<string, string>;
  savedFunctionScopes?: ReadonlyMap<string, FunctionScope>;
  globalFunctions?: ReadonlyMap<string, string>;
  projectFunctions?: ReadonlyMap<string, string>;
  sessionFunctions?: ReadonlyMap<string, string>;
  input?: unknown;
}

export async function compileSandboxSource(
  source: string,
  options: SandboxProgramOptions,
): Promise<string> {
  const savedFunctions = options.savedFunctions ?? new Map<string, string>();
  const scopes = options.savedFunctionScopes ?? new Map<string, FunctionScope>();
  const referenced = resolveSavedFunctionReferences(source, savedFunctions);
  const injectedFunctions = new Map(
    referenced.map((reference) => [reference.name, reference.source]),
  );
  validateTypeScript(source, injectedFunctions, options.input, savedFunctions.keys());
  const explicitRegistries =
    options.globalFunctions || options.projectFunctions || options.sessionFunctions;
  const registries: ScopedFunctionRegistries = explicitRegistries
    ? {
        global: options.globalFunctions ?? new Map(),
        project: options.projectFunctions ?? new Map(),
        session: options.sessionFunctions ?? new Map(),
      }
    : {
        global: new Map([...savedFunctions].filter(([name]) => scopes.get(name) === "global")),
        project: new Map([...savedFunctions].filter(([name]) => scopes.get(name) === "project")),
        session: new Map(
          [...savedFunctions].filter(
            ([name]) => scopes.get(name) !== "global" && scopes.get(name) !== "project",
          ),
        ),
      };
  return await compileTypeScript(
    scopedRuntimeProgram({
      source,
      programExpression: isProgramExpression(source),
      effective: savedFunctions,
      scopes,
      registries,
    }),
  );
}
