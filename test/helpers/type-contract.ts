import ts from "typescript";

/** Type-check a consumer of generated declarations, without comparing their spelling. */
export function typeDiagnostics(source: string): string[] {
  const file = "/pit-type-contract-test.ts";
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    lib: ["lib.es2022.d.ts"],
    types: [],
    strict: true,
    noEmit: true,
    skipLibCheck: true,
  };
  const base = ts.createCompilerHost(options);
  const host: ts.CompilerHost = {
    ...base,
    getSourceFile: (path, version, onError, shouldCreate) =>
      path === file
        ? ts.createSourceFile(path, source, version, true)
        : base.getSourceFile(path, version, onError, shouldCreate),
  };
  return ts
    .getPreEmitDiagnostics(ts.createProgram([file], options, host))
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
}
