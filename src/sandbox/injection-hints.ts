/**
 * Hints for injected functions a program names but the session doesn't define: close names, and
 * what a namespace provides. Validation errors append them to unresolved-name diagnostics.
 */
import * as ts from "typescript";

/** Most unresolved injections a validation error names hints for. */
export const MAX_INJECTION_HINTS = 3;
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

/** A binding key's name: a quoted key names the same injection; a computed one matches none. */
function keyText(element: ts.BindingElement): string {
  return (element.propertyName ?? element.name).getText().replace(/^(["'])(.*)\1$/, "$2");
}

/** Every dotted path a binding pattern destructures down to its leaves, such as `tests.find`. */
function leafPaths(name: ts.BindingName, path: string[]): string[] {
  if (!ts.isObjectBindingPattern(name)) return [path.join(".")];
  return name.elements.flatMap((element) => leafPaths(element.name, [...path, keyText(element)]));
}

/**
 * The dotted injection paths an error at `position` concerns. An error on a namespace key, which
 * TypeScript reports when no function of the namespace was declared, concerns the functions
 * destructured from it.
 */
function injectionPaths(
  name: ts.BindingName,
  position: number,
  path: string[] = [],
): string[] | undefined {
  if (!ts.isObjectBindingPattern(name)) return undefined;
  for (const element of name.elements) {
    const key = element.propertyName ?? element.name;
    const here = [...path, keyText(element)];
    if (position >= key.getStart() && position < key.end) return leafPaths(element.name, here);
    const inner = injectionPaths(element.name, position, here);
    if (inner) return inner;
  }
  return undefined;
}

/**
 * The names an injection error could not resolve: functions destructured in the program's first
 * parameter that do not exist, or an undeclared identifier. Property errors on values the
 * program computes are not injection errors.
 */
export function unresolvedInjections(
  diagnostic: ts.Diagnostic,
  names: readonly string[],
  programFile: string,
): string[] {
  const file = diagnostic.file;
  if (file?.fileName !== programFile || diagnostic.start === undefined) return [];
  if (diagnostic.code === 2304) {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
    /* v8 ignore next -- TS2304 always reads "Cannot find name 'x'." */
    return /^Cannot find name '([^']+)'/.exec(message)?.slice(1) ?? [];
  }
  if (diagnostic.code !== 2339 && diagnostic.code !== 2551) return [];
  const parameter = programFunction(file)?.parameters[0];
  const paths = parameter ? (injectionPaths(parameter.name, diagnostic.start) ?? []) : [];
  // Destructured functions that exist are fine; only the rest are unresolved.
  return paths.filter((path) => !names.includes(path));
}

function boundedList(items: readonly string[], limit: number): string {
  const shown = items.slice(0, limit).join(", ");
  return items.length > limit ? `${shown}, … ${items.length - limit} more` : shown;
}

/** Closest injectable names for an unresolved one, and the methods of a namespace it names. */
export function injectionHint(name: string, names: readonly string[]): string {
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
