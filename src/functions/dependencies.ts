import * as ts from "typescript";

export interface FunctionDependency {
  id: string;
  localName: string;
}

export interface FunctionDependencies {
  dependencies: FunctionDependency[];
  usesNext: boolean;
}

function unwrapParentheses(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return current;
}

function functionLikeExpression(source: string): ts.FunctionLikeDeclaration {
  const direct = ts.createSourceFile(
    "/pit/function.ts",
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  const directStatement = direct.statements[0];
  if (
    direct.statements.length === 1 &&
    directStatement &&
    ts.isFunctionDeclaration(directStatement)
  ) {
    return directStatement;
  }

  const wrapped = ts.createSourceFile(
    "/pit/function-expression.ts",
    `const __pit_function = (${source});`,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  const statement = wrapped.statements[0];
  /* v8 ignore next -- the fixed wrapper always produces one variable statement. */
  if (!statement || !ts.isVariableStatement(statement)) {
    throw new Error("expected a function declaration or expression");
  }
  const initializer = statement.declarationList.declarations[0]?.initializer;
  /* v8 ignore next -- the fixed wrapper always gives its declaration an initializer. */
  if (!initializer) {
    throw new Error("expected a function declaration or expression");
  }
  const expression = unwrapParentheses(initializer);
  if (!(ts.isArrowFunction(expression) || ts.isFunctionExpression(expression))) {
    throw new Error("expected a function declaration or expression");
  }
  return expression;
}

function propertySegment(element: ts.BindingElement): string {
  if (element.propertyName) {
    if (!ts.isIdentifier(element.propertyName)) {
      throw new Error("function dependency names must be TypeScript identifiers");
    }
    return element.propertyName.text;
  }
  /* v8 ignore next -- malformed shorthand object bindings are rejected by the parser. */
  if (!ts.isIdentifier(element.name)) {
    throw new Error("nested function dependency bindings require an explicit property name");
  }
  return element.name.text;
}

function collectDependencies(
  pattern: ts.ObjectBindingPattern,
  prefix: readonly string[],
  output: FunctionDependency[],
): void {
  for (const element of pattern.elements) {
    if (element.dotDotDotToken) {
      throw new Error("function dependencies do not support rest bindings");
    }
    if (element.initializer) {
      throw new Error("function dependencies do not support default values");
    }
    const segment = propertySegment(element);
    const path = [...prefix, segment];
    if (ts.isObjectBindingPattern(element.name)) {
      collectDependencies(element.name, path, output);
      continue;
    }
    if (!ts.isIdentifier(element.name)) {
      throw new Error("function dependencies must use object binding patterns");
    }
    output.push({ id: path.join("."), localName: element.name.text });
  }
}

export function getFunctionDependencies(source: string): FunctionDependencies {
  const declaration = functionLikeExpression(source);
  const dependencyParameter = declaration.parameters[0];
  if (!dependencyParameter) {
    throw new Error("functions must declare dependencies with an object first parameter");
  }
  if (dependencyParameter.dotDotDotToken || dependencyParameter.initializer) {
    throw new Error("the function dependency parameter cannot be optional, rest, or defaulted");
  }
  if (!ts.isObjectBindingPattern(dependencyParameter.name)) {
    throw new Error("functions must declare dependencies with an object first parameter");
  }

  const dependencies: FunctionDependency[] = [];
  collectDependencies(dependencyParameter.name, [], dependencies);
  const duplicate = dependencies.find(
    (candidate, index) => dependencies.findIndex(({ id }) => id === candidate.id) !== index,
  );
  if (duplicate) {
    throw new Error(`function dependency "${duplicate.id}" is declared more than once`);
  }
  const usesNext = dependencies.some(({ id }) => id === "$next");
  if (dependencies.some(({ id }) => id !== "$next" && id.startsWith("$next."))) {
    throw new Error("$next cannot be used as a dependency namespace");
  }
  return {
    dependencies: dependencies.filter(({ id }) => id !== "$next"),
    usesNext,
  };
}
