import { commandsFunctions } from "./builtins/commands.js";
import { contextFunctions } from "./builtins/context.js";
import { functionsFunctions } from "./builtins/functions.js";
import { ghFunctions } from "./builtins/gh.js";
import { gitFunctions } from "./builtins/git.js";
import { httpFunctions } from "./builtins/http.js";
import { modelsFunctions } from "./builtins/models.js";
import { npmFunctions } from "./builtins/npm.js";
import { runtimeFunctions } from "./builtins/runtime.js";
import { sessionFunctions } from "./builtins/session.js";
import { shellFunctions } from "./builtins/shell.js";
import { uiFunctions } from "./builtins/ui.js";
import { workspaceFunctions } from "./builtins/workspace.js";
import type { NativeFunctionDefinition } from "./native-definition.js";

const NATIVE_FUNCTIONS = [
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
  ...functionsFunctions,
] as const;

type Builtin = (typeof NATIVE_FUNCTIONS)[number];
export type NativeNamespace = Builtin["capability"];
export type NativeMethod<Name extends NativeNamespace> = Extract<
  Builtin,
  { capability: Name }
>["method"];

const NATIVE_BY_ID = new Map<string, NativeFunctionDefinition>(
  NATIVE_FUNCTIONS.map((definition) => [definition.id, definition]),
);

export function globalFunctionDefinitions(): NativeFunctionDefinition[] {
  return [...NATIVE_FUNCTIONS];
}

/** Fixed native lookup, deliberately independent of effective source overrides. */
export function getNativeFunction(id: string): NativeFunctionDefinition | undefined {
  return NATIVE_BY_ID.get(id);
}

export function nativeFunctionGroups(): Map<NativeNamespace, NativeFunctionDefinition[]> {
  const groups = new Map<NativeNamespace, NativeFunctionDefinition[]>();
  for (const definition of NATIVE_FUNCTIONS) {
    const group = groups.get(definition.capability) ?? [];
    group.push(definition);
    groups.set(definition.capability, group);
  }
  return groups;
}

// Compatibility view for the public CAPABILITY_METHODS export, not a second catalog.
export const NATIVE_METHODS = Object.fromEntries(
  [...nativeFunctionGroups()].map(([name, definitions]) => [
    name,
    definitions.map(({ method }) => method),
  ]),
) as { [Name in NativeNamespace]: NativeMethod<Name>[] };

export function validateNativeCall(capability: string, method: string, args: unknown[]): void {
  const definition = getNativeFunction(`${capability}.${method}`);
  if (!definition) {
    throw new Error(`Unknown capability or method: ${capability}.${method}`);
  }
  if (args.length < definition.minimumArguments || args.length > definition.maximumArguments) {
    const range =
      definition.minimumArguments === definition.maximumArguments
        ? String(definition.minimumArguments)
        : `${definition.minimumArguments}-${definition.maximumArguments}`;
    throw new Error(
      `${capability}.${method} expects ${range} argument(s); received ${args.length}`,
    );
  }
}
