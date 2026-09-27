export type ResultRendererKey =
  | "read"
  | "edit"
  | "batch"
  | "list"
  | "glob"
  | "search"
  | "stat"
  | "shell"
  | "http"
  | "gh"
  | "git.status"
  | "git.diff"
  | "git.log"
  | "git.add"
  | "git.commit"
  | "git.show"
  | "git.push"
  | "git.tag"
  | "npm.run"
  | "npm.test"
  | "npm.install"
  | "npm.audit"
  | "npm.outdated"
  | "npm.pack";

export interface FunctionMetadata {
  readonly declaration: string;
  readonly signature: string;
  readonly summary: string;
  readonly documentation: string;
  readonly resultRenderer?: ResultRendererKey;
  readonly minimumArguments: number;
  readonly maximumArguments: number;
}

interface GlobalFunctionBase extends FunctionMetadata {
  readonly id: string;
  readonly layer: "global";
  readonly capability: string;
  readonly method: string;
  readonly sealed: boolean;
}

export interface NativeFunctionDefinition extends GlobalFunctionBase {
  readonly kind: "native";
  readonly effect: string;
}

export interface GlobalSourceFunctionDefinition extends GlobalFunctionBase {
  readonly kind: "source";
  readonly source: string;
}

export type GlobalFunctionDefinition = NativeFunctionDefinition | GlobalSourceFunctionDefinition;
export type GlobalFunctionInput = Omit<FunctionMetadata, "signature">;

function globalDefinition<const Namespace extends string, const Method extends string>(
  capability: Namespace,
  method: Method,
  metadata: GlobalFunctionInput,
) {
  return {
    ...metadata,
    id: `${capability}.${method}` as const,
    layer: "global" as const,
    capability,
    method,
    signature: `${capability}.${metadata.declaration.trim().replace(/\s+/g, " ").replace(/;$/, "")}`,
    sealed: capability === "functions",
  };
}

export function defineNativeFunction<const Namespace extends string, const Method extends string>(
  capability: Namespace,
  method: Method,
  metadata: GlobalFunctionInput,
) {
  return Object.freeze({
    ...globalDefinition(capability, method, metadata),
    kind: "native" as const,
    effect: `${capability}.${method}`,
  });
}

export function defineGlobalSourceFunction<
  const Namespace extends string,
  const Method extends string,
>(capability: Namespace, method: Method, metadata: GlobalFunctionInput, source: string) {
  return Object.freeze({
    ...globalDefinition(capability, method, metadata),
    kind: "source" as const,
    source,
  });
}
