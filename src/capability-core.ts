export interface CapabilityCall {
  capability: string;
  method: string;
  qualifiedName: string;
}

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

export interface CapabilityMethodDefinition {
  declaration: string;
  documentation: string;
  callDescription: string;
  resultRenderer?: ResultRendererKey;
  minimumArguments: number;
  maximumArguments: number;
}

export interface CapabilityDefinition {
  interfaceName: string;
  documentation?: string;
  methods: Record<string, CapabilityMethodDefinition>;
}

export function defineCapability<const Definition extends CapabilityDefinition>(
  definition: Definition,
): Definition {
  return definition;
}

export function defineCapabilities<const Registry extends Record<string, CapabilityDefinition>>(
  registry: Registry,
): Registry {
  return registry;
}
