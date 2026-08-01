import {
  type CapabilityMethodDefinition,
  defineCapability,
  type ResultRendererKey,
} from "../capability-core.js";

function gitMethodDefinition(method: string, callDescription: string): CapabilityMethodDefinition {
  return {
    declaration: `${method}(args?: string[], options?: PitProcessOptions): Promise<PitProcessResult>;`,
    documentation: `git.${method}(args?, options?)`,
    callDescription,
    resultRenderer: `git.${method}` as ResultRendererKey,
    minimumArguments: 0,
    maximumArguments: 2,
  };
}

export const gitCapability = defineCapability({
  interfaceName: "PitGitCapability",
  documentation:
    "git.status, git.diff, git.log, git.add, git.commit, git.show, git.push, and git.tag accept optional argument arrays and shell.execFile options; results are bounded",
  methods: {
    status: gitMethodDefinition("status", "Inspect Git status"),
    diff: gitMethodDefinition("diff", "Inspect Git changes"),
    log: gitMethodDefinition("log", "Inspect Git history"),
    add: gitMethodDefinition("add", "Stage Git changes"),
    commit: gitMethodDefinition("commit", "Commit Git changes"),
    show: gitMethodDefinition("show", "Inspect a Git object"),
    push: gitMethodDefinition("push", "Push Git changes"),
    tag: gitMethodDefinition("tag", "Manage Git tags"),
  },
});
