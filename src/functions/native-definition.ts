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

export interface NativeFunctionDefinition {
  readonly id: string;
  readonly kind: "native";
  readonly layer: "global";
  readonly capability: string;
  readonly method: string;
  readonly effect: string;
  readonly sealed: boolean;
  readonly declaration: string;
  readonly signature: string;
  readonly summary: string;
  readonly documentation: string;
  readonly resultRenderer?: ResultRendererKey;
  readonly minimumArguments: number;
  readonly maximumArguments: number;
}

/** Define a host-backed global once, for resolution, validation, reflection, and presentation. */
export function defineNativeFunction<const Namespace extends string, const Method extends string>(
  capability: Namespace,
  method: Method,
  metadata: Pick<
    NativeFunctionDefinition,
    | "declaration"
    | "summary"
    | "documentation"
    | "resultRenderer"
    | "minimumArguments"
    | "maximumArguments"
  >,
) {
  return Object.freeze({
    ...metadata,
    id: `${capability}.${method}` as const,
    kind: "native" as const,
    layer: "global" as const,
    capability,
    method,
    effect: `${capability}.${method}`,
    signature: `${capability}.${metadata.declaration.trim().replace(/\s+/g, " ").replace(/;$/, "")}`,
    sealed: capability === "functions",
  });
}
