import * as ts from "typescript";

const SIGNATURE_WHITESPACE = /\s+/g;
const JSDOC_PARAGRAPH_SEPARATOR = /\r?\n\s*\r?\n/;
const JSDOC_PARAMETER_PREFIX = /^-\s*/;

function submissionExpression(source: string): ts.Expression | undefined {
  const file = ts.createSourceFile(
    "/pit/submission.ts",
    `const __pit_submission = (${source});`,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  const statement = file.statements[0] as ts.VariableStatement;
  let expression = statement.declarationList.declarations[0]?.initializer;
  while (expression && ts.isParenthesizedExpression(expression)) {
    expression = expression.expression;
  }
  return expression;
}

export function isProgramExpression(source: string): boolean {
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

export interface PersistentFunctionParameter {
  name: string;
  description?: string;
}

export interface PersistentFunctionMetadata {
  name: string;
  signature: string;
  summary: string;
  parameters: PersistentFunctionParameter[];
}

export type PersistentFunctionMetadataRegistry = Map<string, PersistentFunctionMetadata>;

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

export function getPersistentFunctionMetadata(
  source: string,
): PersistentFunctionMetadata | undefined {
  const file = ts.createSourceFile(
    "/pit/persistent-function.ts",
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

  const docs = (declaration as ts.FunctionDeclaration & { jsDoc?: ts.JSDoc[] }).jsDoc ?? [];
  const summary =
    docs
      .map((doc) => jsDocText(doc.comment).trim().split(JSDOC_PARAGRAPH_SEPARATOR, 1)[0] as string)
      .find(Boolean) ?? "";
  if (!summary) {
    throw new Error("persistent functions require a JSDoc summary");
  }

  const parameters = ts
    .getJSDocTags(declaration)
    .filter(ts.isJSDocParameterTag)
    .map((tag) => {
      const description = jsDocText(tag.comment).trim().replace(JSDOC_PARAMETER_PREFIX, "");
      const parameter: PersistentFunctionParameter = { name: tag.name.getText(file) };
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

export function getSavedFunctionCallSignature(source: string, id?: string): string | undefined {
  const expression = submissionExpression(source);
  if (!(expression && ts.isFunctionExpression(expression) && expression.name)) {
    return;
  }
  return functionCallSignature(id ?? expression.name.text, expression.parameters);
}
