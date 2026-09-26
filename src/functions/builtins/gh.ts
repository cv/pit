import { defineNativeFunction } from "../native-definition.js";

export const ghFunctions = [
  defineNativeFunction("gh", "issueList", {
    summary: "List GitHub issues",
    resultRenderer: "gh",
    declaration: "issueList(options?: PitGhListOptions): Promise<PitProcessResult>;",
    documentation:
      "gh.issueList({ repo?, state?, author?, assignee?, labels?, search?, json?, args?, limit?, ...processOptions }?)",
    minimumArguments: 0,
    maximumArguments: 1,
  }),
  defineNativeFunction("gh", "issueView", {
    summary: "View a GitHub issue",
    resultRenderer: "gh",
    declaration:
      "issueView(number: number, options?: PitGhJsonOptions): Promise<PitProcessResult>;",
    documentation: "gh.issueView(number, { repo?, json?, args?, ...processOptions }?)",
    minimumArguments: 1,
    maximumArguments: 2,
  }),
  defineNativeFunction("gh", "issueCreate", {
    summary: "Create a GitHub issue",
    resultRenderer: "gh",
    declaration: "issueCreate(input: PitGhCreateOptions): Promise<PitProcessResult>;",
    documentation: "gh.issueCreate({ title, body?, repo?, args?, ...processOptions })",
    minimumArguments: 1,
    maximumArguments: 1,
  }),
  defineNativeFunction("gh", "issueComment", {
    summary: "Comment on a GitHub issue",
    resultRenderer: "gh",
    declaration:
      "issueComment(number: number, body: string, options?: PitGhOptions): Promise<PitProcessResult>;",
    documentation: "gh.issueComment(number, body, { repo?, args?, ...processOptions }?)",
    minimumArguments: 2,
    maximumArguments: 3,
  }),
  defineNativeFunction("gh", "issueClose", {
    summary: "Close a GitHub issue",
    resultRenderer: "gh",
    declaration: "issueClose(number: number, options?: PitGhOptions): Promise<PitProcessResult>;",
    documentation: "gh.issueClose(number, { repo?, args?, ...processOptions }?)",
    minimumArguments: 1,
    maximumArguments: 2,
  }),
  defineNativeFunction("gh", "prList", {
    summary: "List GitHub pull requests",
    resultRenderer: "gh",
    declaration: "prList(options?: PitGhPrListOptions): Promise<PitProcessResult>;",
    documentation:
      "gh.prList({ repo?, state?, author?, assignee?, labels?, search?, base?, head?, draft?, json?, args?, limit?, ...processOptions }?)",
    minimumArguments: 0,
    maximumArguments: 1,
  }),
  defineNativeFunction("gh", "prView", {
    summary: "View a GitHub pull request",
    resultRenderer: "gh",
    declaration: "prView(number: number, options?: PitGhJsonOptions): Promise<PitProcessResult>;",
    documentation: "gh.prView(number, { repo?, json?, args?, ...processOptions }?)",
    minimumArguments: 1,
    maximumArguments: 2,
  }),
  defineNativeFunction("gh", "prCreate", {
    summary: "Create a GitHub pull request",
    resultRenderer: "gh",
    declaration: "prCreate(input: PitGhPrCreateOptions): Promise<PitProcessResult>;",
    documentation:
      "gh.prCreate({ title, body?, base?, head?, draft?, repo?, args?, ...processOptions })",
    minimumArguments: 1,
    maximumArguments: 1,
  }),
  defineNativeFunction("gh", "prMerge", {
    summary: "Merge a GitHub pull request",
    resultRenderer: "gh",
    declaration:
      "prMerge(number: number, options: PitGhPrMergeOptions): Promise<PitProcessResult>;",
    documentation:
      'gh.prMerge(number, { method: "merge" | "squash" | "rebase", deleteBranch?, auto?, repo?, args?, ...processOptions })',
    minimumArguments: 2,
    maximumArguments: 2,
  }),
  defineNativeFunction("gh", "runList", {
    summary: "List GitHub Actions runs",
    resultRenderer: "gh",
    declaration: "runList(options?: PitGhRunListOptions): Promise<PitProcessResult>;",
    documentation:
      "gh.runList({ repo?, branch?, commit?, event?, status?, user?, workflow?, json?, args?, limit?, ...processOptions }?)",
    minimumArguments: 0,
    maximumArguments: 1,
  }),
  defineNativeFunction("gh", "runView", {
    summary: "View a GitHub Actions run",
    resultRenderer: "gh",
    declaration: "runView(id: number, options?: PitGhJsonOptions): Promise<PitProcessResult>;",
    documentation: "gh.runView(id, { repo?, json?, args?, ...processOptions }?)",
    minimumArguments: 1,
    maximumArguments: 2,
  }),
  defineNativeFunction("gh", "releaseView", {
    summary: "View a GitHub release",
    resultRenderer: "gh",
    declaration:
      "releaseView(tag?: string, options?: PitGhJsonOptions): Promise<PitProcessResult>;",
    documentation: "gh.releaseView(tag?, { repo?, json?, args?, ...processOptions }?)",
    minimumArguments: 0,
    maximumArguments: 2,
  }),
  defineNativeFunction("gh", "releaseCreate", {
    summary: "Create a GitHub release",
    resultRenderer: "gh",
    declaration:
      "releaseCreate(tag: string, input: PitGhCreateOptions): Promise<PitProcessResult>;",
    documentation: "gh.releaseCreate(tag, { title, body?, repo?, args?, ...processOptions })",
    minimumArguments: 2,
    maximumArguments: 2,
  }),
  defineNativeFunction("gh", "api", {
    summary: "Call the GitHub API",
    resultRenderer: "gh",
    declaration:
      "api(endpoint: string, args?: string[], options?: PitProcessOptions): Promise<PitProcessResult>;",
    documentation: "gh.api(endpoint, args?, options?) is a bounded argument-safe escape hatch",
    minimumArguments: 1,
    maximumArguments: 3,
  }),
] as const;
