import { defineCommandFunction } from "../command-source.js";
import type { ResultRendererKey } from "../global-definition.js";

function gitFunction<const Method extends string>(method: Method, summary: string) {
  return defineCommandFunction("git", method, {
    declaration: `${method}(args?: string[], options?: PitProcessOptions): Promise<PitProcessResult>;`,
    documentation: `git.${method}(args?, options?)`,
    summary,
    resultRenderer: `git.${method}` as ResultRendererKey,
    minimumArguments: 0,
    maximumArguments: 2,
  });
}

export const gitFunctions = [
  gitFunction("status", "Inspect Git status"),
  gitFunction("diff", "Inspect Git changes"),
  gitFunction("log", "Inspect Git history"),
  gitFunction("add", "Stage Git changes"),
  gitFunction("commit", "Commit Git changes"),
  gitFunction("show", "Inspect a Git object"),
  gitFunction("push", "Push Git changes"),
  gitFunction("tag", "Manage Git tags"),
] as const;
