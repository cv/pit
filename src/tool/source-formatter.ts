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

/** Canonicalize completed model source without making formatter failure block validation. */
export async function formatTypeScriptSource(source: string): Promise<string> {
  if (!source.trim()) {
    return source;
  }
  try {
    const result = await format("pit-tool-call.ts", source, TOOL_SOURCE_FORMAT);
    return result.errors.length === 0 ? removeExpressionTerminator(result.code) : source;
  } catch {
    return source;
  }
}
