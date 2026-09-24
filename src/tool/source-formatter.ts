import { type FormatConfig, format } from "oxfmt";
import * as ts from "typescript";

const TOOL_SOURCE_FORMAT: FormatConfig = {
  arrowParens: "always",
  bracketSameLine: false,
  bracketSpacing: true,
  embeddedLanguageFormatting: "off",
  endOfLine: "lf",
  insertFinalNewline: false,
  jsdoc: false,
  objectWrap: "preserve",
  printWidth: 100,
  quoteProps: "as-needed",
  semi: true,
  singleQuote: false,
  sortImports: false,
  sortPackageJson: false,
  sortTailwindcss: false,
  tabWidth: 2,
  trailingComma: "all",
  useTabs: false,
};

function removeExpressionTerminator(source: string): string {
  const file = ts.createSourceFile(
    "pit-tool-call.ts",
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  const statement = file.statements.length === 1 ? file.statements[0] : undefined;
  if (!(statement && ts.isExpressionStatement(statement))) {
    return source;
  }
  const trailing = source.slice(statement.expression.end, statement.end);
  const terminator = trailing.indexOf(";");
  /* v8 ignore next -- semi=true always terminates a formatted expression statement. */
  if (terminator < 0) {
    return source;
  }
  const offset = statement.expression.end + terminator;
  return source.slice(0, offset) + source.slice(offset + 1);
}

const formattingCache = new Map<string, Promise<string>>();
const MAX_FORMATTING_ENTRIES = 64;
const MAX_CACHED_SOURCE_CHARS = 32_000;

/** Share in-flight display/execution formatting; failures remain retryable. */
export function formatTypeScriptSource(source: string): Promise<string> {
  if (!source.trim()) return Promise.resolve(source);
  const cached = formattingCache.get(source);
  if (cached) return cached;
  const forget = () => {
    if (formattingCache.get(source) === pending) formattingCache.delete(source);
  };
  const pending = Promise.resolve()
    .then(() => format("pit-tool-call.ts", source, TOOL_SOURCE_FORMAT))
    .then((result) => {
      if (result.errors.length > 0) {
        forget();
        return source;
      }
      return removeExpressionTerminator(result.code);
    })
    .catch(() => {
      forget();
      return source;
    });
  if (source.length <= MAX_CACHED_SOURCE_CHARS) {
    formattingCache.set(source, pending);
    if (formattingCache.size > MAX_FORMATTING_ENTRIES) {
      const oldest = formattingCache.keys().next().value;
      if (oldest !== undefined) formattingCache.delete(oldest);
    }
  }
  return pending;
}
