import { defineCapability } from "../capability-core.js";

export const ghCapability = defineCapability({
  interfaceName: "PitGhCapability",
  documentation:
    "gh.issueList, gh.issueView, gh.issueCreate, gh.issueComment, gh.issueClose, gh.prList, gh.prView, gh.runList, gh.runView, gh.releaseView, gh.releaseCreate, and gh.api provide typed bounded GitHub CLI workflows",
  methods: {
    issueList: {
      callDescription: "List GitHub issues",
      resultRenderer: "gh",
      declaration: "issueList(options?: PitGhListOptions): Promise<PitProcessResult>;",
      documentation: "gh.issueList({ repo?, state?, limit?, ...processOptions }?)",
      minimumArguments: 0,
      maximumArguments: 1,
    },
    issueView: {
      callDescription: "View a GitHub issue",
      resultRenderer: "gh",
      declaration: "issueView(number: number, options?: PitGhOptions): Promise<PitProcessResult>;",
      documentation: "gh.issueView(number, options?)",
      minimumArguments: 1,
      maximumArguments: 2,
    },
    issueCreate: {
      callDescription: "Create a GitHub issue",
      resultRenderer: "gh",
      declaration: "issueCreate(input: PitGhCreateOptions): Promise<PitProcessResult>;",
      documentation: "gh.issueCreate({ title, body?, repo?, ...processOptions })",
      minimumArguments: 1,
      maximumArguments: 1,
    },
    issueComment: {
      callDescription: "Comment on a GitHub issue",
      resultRenderer: "gh",
      declaration:
        "issueComment(number: number, body: string, options?: PitGhOptions): Promise<PitProcessResult>;",
      documentation: "gh.issueComment(number, body, options?)",
      minimumArguments: 2,
      maximumArguments: 3,
    },
    issueClose: {
      callDescription: "Close a GitHub issue",
      resultRenderer: "gh",
      declaration: "issueClose(number: number, options?: PitGhOptions): Promise<PitProcessResult>;",
      documentation: "gh.issueClose(number, options?)",
      minimumArguments: 1,
      maximumArguments: 2,
    },
    prList: {
      callDescription: "List GitHub pull requests",
      resultRenderer: "gh",
      declaration: "prList(options?: PitGhListOptions): Promise<PitProcessResult>;",
      documentation: "gh.prList({ repo?, state?, limit?, ...processOptions }?)",
      minimumArguments: 0,
      maximumArguments: 1,
    },
    prView: {
      callDescription: "View a GitHub pull request",
      resultRenderer: "gh",
      declaration: "prView(number: number, options?: PitGhOptions): Promise<PitProcessResult>;",
      documentation: "gh.prView(number, options?)",
      minimumArguments: 1,
      maximumArguments: 2,
    },
    runList: {
      callDescription: "List GitHub Actions runs",
      resultRenderer: "gh",
      declaration:
        "runList(options?: PitGhOptions & { limit?: number }): Promise<PitProcessResult>;",
      documentation: "gh.runList({ repo?, limit?, ...processOptions }?)",
      minimumArguments: 0,
      maximumArguments: 1,
    },
    runView: {
      callDescription: "View a GitHub Actions run",
      resultRenderer: "gh",
      declaration: "runView(id: number, options?: PitGhOptions): Promise<PitProcessResult>;",
      documentation: "gh.runView(id, options?)",
      minimumArguments: 1,
      maximumArguments: 2,
    },
    releaseView: {
      callDescription: "View a GitHub release",
      resultRenderer: "gh",
      declaration: "releaseView(tag?: string, options?: PitGhOptions): Promise<PitProcessResult>;",
      documentation: "gh.releaseView(tag?, options?)",
      minimumArguments: 0,
      maximumArguments: 2,
    },
    releaseCreate: {
      callDescription: "Create a GitHub release",
      resultRenderer: "gh",
      declaration:
        "releaseCreate(tag: string, input: PitGhCreateOptions): Promise<PitProcessResult>;",
      documentation: "gh.releaseCreate(tag, { title, body?, repo?, ...processOptions })",
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
