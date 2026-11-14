import { defineCommandFunction } from "../command-source.js";
import type { ResultRendererKey } from "../global-definition.js";

function gitFunction<const Method extends string>(
  method: Method,
  summary: string,
  subcommand: string = method,
) {
  return defineCommandFunction("git", method, {
    declaration: `${method}(args?: string[], options?: PitProcessOptions): Promise<PitProcessResult>;`,
    documentation:
      subcommand === method
        ? `git.${method}(args?, options?)`
        : `git.${method}(args?, options?) runs git ${subcommand}`,
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
  gitFunction("switch", "Switch Git branches"),
  gitFunction("fetch", "Fetch Git refs"),
  gitFunction("pull", "Pull Git changes"),
  gitFunction("revParse", "Resolve Git revisions", "rev-parse"),
  gitFunction("lsRemote", "List remote Git refs", "ls-remote"),
] as const;
