import {
  stringArrayValue as list,
  recordValue as object,
  stringValue as text,
} from "../../shared/argument-values.js";
import type { CAPABILITY_METHODS } from "../registry.js";

type GhMethod = (typeof CAPABILITY_METHODS)["gh"][number];
export interface PreparedGhCommand {
  args: string[];
  options: Record<string, unknown>;
}

const commandOptionKeys = [
  "repo",
  "args",
  "json",
  "state",
  "limit",
  "author",
  "assignee",
  "labels",
  "search",
  "base",
  "head",
  "draft",
  "branch",
  "commit",
  "event",
  "status",
  "user",
  "workflow",
  "title",
  "body",
  "method",
  "deleteBranch",
  "auto",
];
const MERGE_METHODS = new Set(["merge", "squash", "rebase"]);

function number(value: unknown, label: string): number {
  if (!Number.isInteger(value)) {
    throw new TypeError(`${label} must be an integer`);
  }
  return value as number;
}

function options(value: unknown) {
  if (value === undefined) {
    return {};
  }
  const copy = { ...object(value) };
  for (const key of commandOptionKeys) {
    delete copy[key];
  }
  return copy;
}

function repo(raw: Record<string, unknown>): string[] {
  return raw.repo === undefined ? [] : ["--repo", text(raw.repo, "options.repo")];
}

function extraArgs(raw: Record<string, unknown>): string[] {
  return raw.args === undefined ? [] : list(raw.args, "options.args");
}

function limit(raw: Record<string, unknown>): string[] {
  return raw.limit === undefined ? [] : ["--limit", String(number(raw.limit, "options.limit"))];
}

function flag(raw: Record<string, unknown>, key: string, cliFlag = key): string[] {
  return raw[key] === undefined ? [] : [`--${cliFlag}`, text(raw[key], `options.${key}`)];
}

function repeatedFlag(raw: Record<string, unknown>, key: string, cliFlag = key): string[] {
  if (raw[key] === undefined) {
    return [];
  }
  return list(raw[key], `options.${key}`).flatMap((value) => [`--${cliFlag}`, value]);
}

function booleanFlag(raw: Record<string, unknown>, key: string, cliFlag = key): string[] {
  if (raw[key] === undefined) {
    return [];
  }
  if (typeof raw[key] !== "boolean") {
    throw new TypeError(`options.${key} must be a boolean`);
  }
  return raw[key] ? [`--${cliFlag}`] : [];
}

function json(raw: Record<string, unknown>, defaults: string): string[] {
  if (raw.json === undefined) {
    return ["--json", defaults];
  }
  const fields = list(raw.json, "options.json");
  if (fields.length === 0) {
    throw new TypeError("options.json must contain at least one field");
  }
  return ["--json", fields.join(",")];
}

function commonListFilters(raw: Record<string, unknown>): string[] {
  return [
    ...flag(raw, "author"),
    ...flag(raw, "assignee"),
    ...repeatedFlag(raw, "labels", "label"),
    ...flag(raw, "search"),
  ];
}

const issueFields = "number,title,state,url,labels";
const prFields =
  "number,title,state,url,headRefName,baseRefName,mergeable,reviewDecision,statusCheckRollup";
const runFields = "databaseId,status,conclusion,url,name,headSha";
const releaseFields = "tagName,name,url,isDraft,isPrerelease,publishedAt";

function prepareIssueList(raw: Record<string, unknown>): PreparedGhCommand {
  return {
    args: [
      "issue",
      "list",
      ...repo(raw),
      ...flag(raw, "state"),
      ...limit(raw),
      ...commonListFilters(raw),
      ...extraArgs(raw),
      ...json(raw, issueFields),
    ],
    options: options(raw),
  };
}

function rawArgument(args: unknown[], index: number): Record<string, unknown> {
  return args[index] === undefined ? {} : object(args[index]);
}

function prepareIssueCommand(method: GhMethod, args: unknown[]): PreparedGhCommand | undefined {
  switch (method) {
    case "issueList":
      return prepareIssueList(rawArgument(args, 0));
    case "issueView": {
      const o = rawArgument(args, 1);
      return {
        args: [
          "issue",
          "view",
          String(number(args[0], "number")),
          ...repo(o),
          ...extraArgs(o),
          ...json(o, `${issueFields},body,comments`),
        ],
        options: options(o),
      };
    }
    case "issueCreate": {
      const o = object(args[0], "input");
      return {
        args: [
          "issue",
          "create",
          ...repo(o),
          "--title",
          text(o.title, "input.title"),
          ...(typeof o.body === "string" ? ["--body", o.body] : []),
          ...extraArgs(o),
        ],
        options: options(o),
      };
    }
    case "issueComment": {
      const o = rawArgument(args, 2);
      return {
        args: [
          "issue",
          "comment",
          String(number(args[0], "number")),
          ...repo(o),
          "--body",
          text(args[1], "body"),
          ...extraArgs(o),
        ],
        options: options(o),
      };
    }
    case "issueClose": {
      const o = rawArgument(args, 1);
      return {
        args: ["issue", "close", String(number(args[0], "number")), ...repo(o), ...extraArgs(o)],
        options: options(o),
      };
    }
    default:
      return;
  }
}

function preparePullRequestCommand(
  method: GhMethod,
  args: unknown[],
): PreparedGhCommand | undefined {
  switch (method) {
    case "prList": {
      const o = rawArgument(args, 0);
      return {
        args: [
          "pr",
          "list",
          ...repo(o),
          ...flag(o, "state"),
          ...limit(o),
          ...commonListFilters(o),
          ...flag(o, "base"),
          ...flag(o, "head"),
          ...booleanFlag(o, "draft"),
          ...extraArgs(o),
          ...json(o, prFields),
        ],
        options: options(o),
      };
    }
    case "prView": {
      const o = rawArgument(args, 1);
      return {
        args: [
          "pr",
          "view",
          String(number(args[0], "number")),
          ...repo(o),
          ...extraArgs(o),
          ...json(o, `${prFields},body,comments,reviews`),
        ],
        options: options(o),
      };
    }
    case "prCreate": {
      const o = object(args[0], "input");
      return {
        args: [
          "pr",
          "create",
          ...repo(o),
          "--title",
          text(o.title, "input.title"),
          // Without a terminal, gh would prompt for a missing body instead of creating the PR.
          "--body",
          o.body === undefined ? "" : text(o.body, "input.body"),
          ...flag(o, "base"),
          ...flag(o, "head"),
          ...booleanFlag(o, "draft"),
          ...extraArgs(o),
        ],
        options: options(o),
      };
    }
    case "prMerge": {
      const o = object(args[1], "options");
      // Required: gh prompts without one, and repositories allow different methods.
      if (!MERGE_METHODS.has(String(o.method))) {
        throw new TypeError("options.method must be merge, squash, or rebase");
      }
      return {
        args: [
          "pr",
          "merge",
          String(number(args[0], "number")),
          ...repo(o),
          `--${String(o.method)}`,
          ...booleanFlag(o, "deleteBranch", "delete-branch"),
          ...booleanFlag(o, "auto"),
          ...extraArgs(o),
        ],
        options: options(o),
      };
    }
    default:
      return;
  }
}

function prepareRunCommand(method: GhMethod, args: unknown[]): PreparedGhCommand | undefined {
  switch (method) {
    case "runList": {
      const o = rawArgument(args, 0);
      return {
        args: [
          "run",
          "list",
          ...repo(o),
          ...limit(o),
          ...flag(o, "branch"),
          ...flag(o, "commit"),
          ...flag(o, "event"),
          ...flag(o, "status"),
          ...flag(o, "user"),
          ...flag(o, "workflow"),
          ...extraArgs(o),
          ...json(o, runFields),
        ],
        options: options(o),
      };
    }
    case "runView": {
      const o = rawArgument(args, 1);
      return {
        args: [
          "run",
          "view",
          String(number(args[0], "id")),
          ...repo(o),
          ...extraArgs(o),
          ...json(o, `${runFields},jobs`),
        ],
        options: options(o),
      };
    }
    default:
      return;
  }
}

function prepareReleaseCommand(method: GhMethod, args: unknown[]): PreparedGhCommand | undefined {
  switch (method) {
    case "releaseView": {
      const o = rawArgument(args, 1);
      return {
        args: [
          "release",
          "view",
          ...(args[0] === undefined || args[0] === null ? [] : [text(args[0], "tag")]),
          ...repo(o),
          ...extraArgs(o),
          ...json(o, releaseFields),
        ],
        options: options(o),
      };
    }
    case "releaseCreate": {
      const o = object(args[1], "input");
      return {
        args: [
          "release",
          "create",
          text(args[0], "tag"),
          ...repo(o),
          "--title",
          text(o.title, "input.title"),
          ...(typeof o.body === "string" ? ["--notes", o.body] : []),
          ...extraArgs(o),
        ],
        options: options(o),
      };
    }
    case "api": {
      const o = rawArgument(args, 2);
      return {
        args: [
          "api",
          text(args[0], "endpoint"),
          ...(args[1] === undefined ? [] : list(args[1], "args")),
        ],
        options: options(o),
      };
    }
    default:
      return;
  }
}

export function prepareGhCommand(method: GhMethod, args: unknown[]): PreparedGhCommand {
  const prepared =
    prepareIssueCommand(method, args) ??
    preparePullRequestCommand(method, args) ??
    prepareRunCommand(method, args) ??
    prepareReleaseCommand(method, args);
  if (!prepared) {
    throw new Error(`Unknown gh method: ${method}`);
  }
  return prepared;
}
