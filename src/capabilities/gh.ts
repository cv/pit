import { defineCapability } from "./core.js";

export const ghCapability = defineCapability({
  interfaceName: "PitGhCapability",
  documentation:
    "typed bounded issue/PR/run/release workflows with selectable JSON fields, common list filters, and argument-safe extra args; api is the escape hatch",
  methods: {
    issueList: {
      callDescription: "List GitHub issues",
      resultRenderer: "gh",
      declaration: "issueList(options?: PitGhListOptions): Promise<PitProcessResult>;",
      documentation:
        "gh.issueList({ repo?, state?, author?, assignee?, labels?, search?, json?, args?, limit?, ...processOptions }?)",
      minimumArguments: 0,
      maximumArguments: 1,
    },
    issueView: {
      callDescription: "View a GitHub issue",
      resultRenderer: "gh",
      declaration:
        "issueView(number: number, options?: PitGhJsonOptions): Promise<PitProcessResult>;",
      documentation: "gh.issueView(number, { repo?, json?, args?, ...processOptions }?)",
      minimumArguments: 1,
      maximumArguments: 2,
    },
    issueCreate: {
      callDescription: "Create a GitHub issue",
      resultRenderer: "gh",
      declaration: "issueCreate(input: PitGhCreateOptions): Promise<PitProcessResult>;",
      documentation: "gh.issueCreate({ title, body?, repo?, args?, ...processOptions })",
      minimumArguments: 1,
      maximumArguments: 1,
    },
    issueComment: {
      callDescription: "Comment on a GitHub issue",
      resultRenderer: "gh",
      declaration:
        "issueComment(number: number, body: string, options?: PitGhOptions): Promise<PitProcessResult>;",
      documentation: "gh.issueComment(number, body, { repo?, args?, ...processOptions }?)",
      minimumArguments: 2,
      maximumArguments: 3,
    },
    issueClose: {
      callDescription: "Close a GitHub issue",
      resultRenderer: "gh",
      declaration: "issueClose(number: number, options?: PitGhOptions): Promise<PitProcessResult>;",
      documentation: "gh.issueClose(number, { repo?, args?, ...processOptions }?)",
      minimumArguments: 1,
      maximumArguments: 2,
    },
    prList: {
      callDescription: "List GitHub pull requests",
      resultRenderer: "gh",
      declaration: "prList(options?: PitGhPrListOptions): Promise<PitProcessResult>;",
      documentation:
        "gh.prList({ repo?, state?, author?, assignee?, labels?, search?, base?, head?, draft?, json?, args?, limit?, ...processOptions }?)",
      minimumArguments: 0,
      maximumArguments: 1,
    },
    prView: {
      callDescription: "View a GitHub pull request",
      resultRenderer: "gh",
      declaration: "prView(number: number, options?: PitGhJsonOptions): Promise<PitProcessResult>;",
      documentation: "gh.prView(number, { repo?, json?, args?, ...processOptions }?)",
      minimumArguments: 1,
      maximumArguments: 2,
    },
    prCreate: {
      callDescription: "Create a GitHub pull request",
      resultRenderer: "gh",
      declaration: "prCreate(input: PitGhPrCreateOptions): Promise<PitProcessResult>;",
      documentation:
        "gh.prCreate({ title, body?, base?, head?, draft?, repo?, args?, ...processOptions })",
      minimumArguments: 1,
      maximumArguments: 1,
    },
    prMerge: {
      callDescription: "Merge a GitHub pull request",
      resultRenderer: "gh",
      declaration:
        "prMerge(number: number, options: PitGhPrMergeOptions): Promise<PitProcessResult>;",
      documentation:
        'gh.prMerge(number, { method: "merge" | "squash" | "rebase", deleteBranch?, auto?, repo?, args?, ...processOptions })',
      minimumArguments: 2,
      maximumArguments: 2,
    },
    runList: {
      callDescription: "List GitHub Actions runs",
      resultRenderer: "gh",
      declaration: "runList(options?: PitGhRunListOptions): Promise<PitProcessResult>;",
      documentation:
        "gh.runList({ repo?, branch?, commit?, event?, status?, user?, workflow?, json?, args?, limit?, ...processOptions }?)",
      minimumArguments: 0,
      maximumArguments: 1,
    },
    runView: {
      callDescription: "View a GitHub Actions run",
      resultRenderer: "gh",
      declaration: "runView(id: number, options?: PitGhJsonOptions): Promise<PitProcessResult>;",
      documentation: "gh.runView(id, { repo?, json?, args?, ...processOptions }?)",
      minimumArguments: 1,
      maximumArguments: 2,
    },
    releaseView: {
      callDescription: "View a GitHub release",
      resultRenderer: "gh",
      declaration:
        "releaseView(tag?: string, options?: PitGhJsonOptions): Promise<PitProcessResult>;",
      documentation: "gh.releaseView(tag?, { repo?, json?, args?, ...processOptions }?)",
      minimumArguments: 0,
      maximumArguments: 2,
    },
    releaseCreate: {
      callDescription: "Create a GitHub release",
      resultRenderer: "gh",
      declaration:
        "releaseCreate(tag: string, input: PitGhCreateOptions): Promise<PitProcessResult>;",
      documentation: "gh.releaseCreate(tag, { title, body?, repo?, args?, ...processOptions })",
      minimumArguments: 2,
      maximumArguments: 2,
    },
    api: {
      callDescription: "Call the GitHub API",
      resultRenderer: "gh",
      declaration:
        "api(endpoint: string, args?: string[], options?: PitProcessOptions): Promise<PitProcessResult>;",
      documentation: "gh.api(endpoint, args?, options?) is a bounded argument-safe escape hatch",
      minimumArguments: 1,
      maximumArguments: 3,
    },
  },
});
