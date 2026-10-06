import ts from "typescript";

const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  // Treat the input as a module and preserve its syntax, so the output is the expression itself:
  // no "use strict" prologue (which would change script semantics) and no `export {}` marker.
  module: ts.ModuleKind.Preserve,
  moduleDetection: ts.ModuleDetectionKind.Force,
  inlineSourceMap: true,
};

/**
 * Transpiles one TypeScript expression to ES2022 JavaScript with an inline source map. Types are
 * erased without type checking; callers validate the source first.
 */
export function transpileTypeScriptExpression(source: string): string {
  const result = ts.transpileModule(`(${source})`, {
    compilerOptions: COMPILER_OPTIONS,
    reportDiagnostics: true,
  });
  const diagnostics = result.diagnostics ?? [];
  /* v8 ignore next 6 -- malformed submissions fail semantic validation before compilation. */
  if (diagnostics.length > 0) {
    const messages = diagnostics.map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    );
    throw new Error(`TypeScript compilation failed: ${messages.join("; ")}`);
  }
  return result.outputText;
}
