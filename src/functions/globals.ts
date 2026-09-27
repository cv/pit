import type { GlobalFunctionDefinition, NativeFunctionDefinition } from "./global-definition.js";
import { commandsFunctions } from "./globals/commands.js";
import { contextFunctions } from "./globals/context.js";
import { functionControlFunctions } from "./globals/functions.js";
import { ghFunctions } from "./globals/gh.js";
import { gitFunctions } from "./globals/git.js";
import { httpFunctions } from "./globals/http.js";
import { modelsFunctions } from "./globals/models.js";
import { npmFunctions } from "./globals/npm.js";
import { runtimeFunctions } from "./globals/runtime.js";
import { sessionFunctions } from "./globals/session.js";
import { shellFunctions } from "./globals/shell.js";
import { uiFunctions } from "./globals/ui.js";
import { workspaceFunctions } from "./globals/workspace.js";

const GLOBAL_FUNCTIONS = [
  ...workspaceFunctions,
  ...gitFunctions,
  ...npmFunctions,
  ...ghFunctions,
  ...shellFunctions,
  ...httpFunctions,
  ...uiFunctions,
  ...contextFunctions,
  ...sessionFunctions,
  ...commandsFunctions,
  ...modelsFunctions,
  ...runtimeFunctions,
  ...functionControlFunctions,
] as const;

type PackageFunction = (typeof GLOBAL_FUNCTIONS)[number];
type Native = Extract<PackageFunction, { kind: "native" }>;
export type GlobalNamespace = PackageFunction["namespace"];
export type NativeNamespace = Native["namespace"];
export type NativeMethod<Name extends NativeNamespace> = Extract<
  Native,
  { namespace: Name }
>["method"];

const GLOBAL_BY_ID = new Map<string, GlobalFunctionDefinition>(
  GLOBAL_FUNCTIONS.map((definition) => [definition.id, definition]),
);

export function globalFunctionDefinitions(): GlobalFunctionDefinition[] {
  return [...GLOBAL_FUNCTIONS];
}

/** Fixed native lookup, deliberately independent of effective source overrides. */
function getNativeFunction(id: string): NativeFunctionDefinition | undefined {
  const definition = getGlobalFunction(id);
  return definition?.kind === "native" ? definition : undefined;
}

export function globalFunctionGroups(): Map<GlobalNamespace, GlobalFunctionDefinition[]> {
  const groups = new Map<GlobalNamespace, GlobalFunctionDefinition[]>();
  for (const definition of GLOBAL_FUNCTIONS) {
    const group = groups.get(definition.namespace) ?? [];
    group.push(definition);
    groups.set(definition.namespace, group);
  }
  return groups;
}

// Public namespace view derived from the global definitions, not a second catalog.
export const GLOBAL_METHODS = Object.fromEntries(
  [...globalFunctionGroups()].map(([name, definitions]) => [
    name,
    definitions.map(({ method }) => method),
  ]),
) as { [Name in GlobalNamespace]: Extract<PackageFunction, { namespace: Name }>["method"][] };

export function validateNativeCall(namespace: string, method: string, args: unknown[]): void {
  const definition = getNativeFunction(`${namespace}.${method}`);
  if (!definition) {
    throw new Error(`Unknown host function: ${namespace}.${method}`);
  }
  if (args.length < definition.minimumArguments || args.length > definition.maximumArguments) {
    const range =
      definition.minimumArguments === definition.maximumArguments
        ? String(definition.minimumArguments)
        : `${definition.minimumArguments}-${definition.maximumArguments}`;
    throw new Error(`${namespace}.${method} expects ${range} argument(s); received ${args.length}`);
  }
}

export function getGlobalFunction(id: string): GlobalFunctionDefinition | undefined {
  return GLOBAL_BY_ID.get(id);
}
