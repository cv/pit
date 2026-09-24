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

function admitsString(type: ts.TypeNode): boolean {
  if (ts.isParenthesizedTypeNode(type)) return admitsString(type.type);
  if (ts.isUnionTypeNode(type)) return type.types.some(admitsString);
  if (ts.isLiteralTypeNode(type)) {
    return ts.isStringLiteral(type.literal) || ts.isNoSubstitutionTemplateLiteral(type.literal);
  }
  if (ts.isTypeReferenceNode(type)) return type.typeName.getText() === "String";
  return (
    ts.isTemplateLiteralTypeNode(type) ||
    type.kind === ts.SyntaxKind.StringKeyword ||
    type.kind === ts.SyntaxKind.AnyKeyword ||
    type.kind === ts.SyntaxKind.UnknownKeyword
  );
}

/**
 * Reports whether a program's annotated input parameter admits a string, or `undefined` when
 * the program has no annotated second parameter.
 */
export function programInputAdmitsString(source: string): boolean | undefined {
  const expression = submissionExpression(source);
  if (!(expression && (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)))) {
    return;
  }
  const type = expression.parameters[1]?.type;
  return type ? admitsString(type) : undefined;
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

function functionCallSignature(name: string, declaration: ts.FunctionLikeDeclaration): string {
  const parameters = declaration.parameters.slice(1).map((parameter) => {
    const optional = parameter.questionToken || parameter.initializer ? "?" : "";
    const rest = parameter.dotDotDotToken ? "..." : "";
    const type = (parameter.type?.getText() ?? "unknown").replace(SIGNATURE_WHITESPACE, " ");
    return `${rest}${parameter.name.getText()}${optional}: ${type}`;
  });
  const generics = declaration.typeParameters?.length
    ? `<${declaration.typeParameters.map((parameter) => parameter.getText()).join(", ")}>`
    : "";
  const result = declaration.type ? `: ${declaration.type.getText()}` : "";
  return `${name}${generics}(${parameters.join(", ")})${result}`.replace(SIGNATURE_WHITESPACE, " ");
}

export function getPersistentFunctionMetadata(
  source: string,
  id?: string,
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
    name: id ?? declaration.name.text,
    signature: functionCallSignature(id ?? declaration.name.text, declaration),
    summary,
    parameters,
  };
}

export function getSavedFunctionCallSignature(source: string, id?: string): string | undefined {
  const expression = submissionExpression(source);
  if (!(expression && ts.isFunctionExpression(expression) && expression.name)) {
    return;
  }
  return functionCallSignature(id ?? expression.name.text, expression);
}

export function getFunctionTypeParameters(source: string): {
  declaration: string;
  arguments: string;
} {
  const expression = submissionExpression(source);
  if (
    !expression ||
    !(ts.isFunctionExpression(expression) || ts.isArrowFunction(expression)) ||
    !expression.typeParameters?.length
  ) {
    return { declaration: "", arguments: "" };
  }
  return {
    declaration: `<${expression.typeParameters.map((parameter) => parameter.getText()).join(", ")}>`,
    arguments: `<${expression.typeParameters.map((parameter) => parameter.name.text).join(", ")}>`,
  };
}
