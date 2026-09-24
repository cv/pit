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

const JSDOC_LINE_PREFIX = /^\s*\*?\s?/;

function replaceJsDocSummary(block: string, summary: string): string {
  const inner = block.slice(3, -2);
  if (!inner.includes("\n")) {
    const content = inner.trim();
    const tagStart = content.search(/(^|\s)@/);
    const description = (tagStart < 0 ? content : content.slice(0, tagStart)).trim();
    const tags = tagStart < 0 ? "" : content.slice(tagStart).trim();
    return description === summary ? block : `/** ${[summary, tags].filter(Boolean).join(" ")} */`;
  }

  const lines = inner.split("\n");
  const text = (index: number) =>
    (index === 0 ? lines[index] : lines[index]?.replace(JSDOC_LINE_PREFIX, ""))?.trim() ?? "";
  const continuation = lines.slice(1).find((line) => /^\s*\*/.test(line));
  const prefix = `${continuation?.match(/^\s*\*/)?.[0] ?? " *"} `;
  const first = lines.findIndex((_, index) => text(index).length > 0);

  if (first < 0 || text(first).startsWith("@")) {
    const insertAt = first < 0 ? 1 : first;
    const moved = first === 0 ? [`${prefix}${text(0)}`] : [];
    const separator = first < 0 ? [] : [prefix.trimEnd()];
    return `/**${[
      ...lines.slice(0, insertAt === 0 ? 0 : insertAt),
      ...(insertAt === 0 ? [""] : []),
      `${prefix}${summary}`,
      ...separator,
      ...moved,
      ...lines.slice(first === 0 ? 1 : insertAt),
    ].join("\n")}*/`;
  }

  let end = first;
  while (end < lines.length && text(end) !== "" && !text(end).startsWith("@")) end++;
  const current = lines
    .slice(first, end)
    .map((_, offset) => text(first + offset))
    .join(" ")
    .replace(SIGNATURE_WHITESPACE, " ");
  if (current === summary) return block;
  const replacement = first === 0 ? ` ${summary}` : `${prefix}${summary}`;
  return `/**${[...lines.slice(0, first), replacement, ...lines.slice(end)].join("\n")}*/`;
}

/**
 * Makes `summary` the summary paragraph of a definition's leading JSDoc block. An
 * undocumented definition gains a one-line block; a documented one keeps its other
 * paragraphs and tags, and is returned unchanged when its summary already matches.
 */
export function withPersistentSummary(source: string, summary: string): string {
  const file = ts.createSourceFile(
    "/pit/promotion.ts",
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  const declaration = file.statements[0];
  const doc =
    declaration && ts.isFunctionDeclaration(declaration)
      ? (declaration as ts.FunctionDeclaration & { jsDoc?: ts.JSDoc[] }).jsDoc?.at(-1)
      : undefined;
  if (!doc) return `/** ${summary} */\n${source}`;
  const start = doc.getStart(file);
  return (
    source.slice(0, start) +
    replaceJsDocSummary(source.slice(start, doc.end), summary) +
    source.slice(doc.end)
  );
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
