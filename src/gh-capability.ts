import type { CAPABILITY_METHODS } from "./capability-registry.js";

type GhMethod = (typeof CAPABILITY_METHODS)["gh"][number];
export interface PreparedGhCommand {
  args: string[];
  options: Record<string, unknown>;
}
function object(value: unknown, label = "options"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }
  return value;
}
function number(value: unknown, label: string): number {
  if (!Number.isInteger(value)) {
    throw new TypeError(`${label} must be an integer`);
  }
  return value as number;
}
function list(value: unknown, label: string): string[] {
  if (!(Array.isArray(value) && value.every((x) => typeof x === "string"))) {
    throw new TypeError(`${label} must be an array of strings`);
  }
  return value;
}
function options(value: unknown, special: string[] = []) {
  if (value === undefined) {
    return {};
  }
  const copy = { ...object(value) };
  for (const key of ["repo", "state", "limit", "title", "body", ...special]) {
    delete copy[key];
  }
  return copy;
}
function repo(raw: Record<string, unknown>): string[] {
  return typeof raw.repo === "string" ? ["--repo", raw.repo] : [];
}
function limit(raw: Record<string, unknown>): string[] {
  return raw.limit === undefined ? [] : ["--limit", String(number(raw.limit, "options.limit"))];
}
function state(raw: Record<string, unknown>): string[] {
  return raw.state === undefined ? [] : ["--state", text(raw.state, "options.state")];
}
const issueFields = "number,title,state,url,labels";
const prFields =
  "number,title,state,url,headRefName,baseRefName,mergeable,reviewDecision,statusCheckRollup";
const runFields = "databaseId,status,conclusion,url,name,headSha";
export function prepareGhCommand(method: GhMethod, args: unknown[]): PreparedGhCommand {
  const raw = (index: number) => (args[index] === undefined ? {} : object(args[index]));
  switch (method) {
    case "issueList": {
      const o = raw(0);
      return {
        args: ["issue", "list", ...repo(o), ...state(o), ...limit(o), "--json", issueFields],
        options: options(o),
      };
    }
    case "issueView": {
      const o = raw(1);
      return {
        args: [
          "issue",
          "view",
          String(number(args[0], "number")),
          ...repo(o),
          "--json",
          `${issueFields},body,comments`,
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
        ],
        options: options(o),
      };
    }
    case "issueComment": {
      const o = raw(2);
      return {
        args: [
          "issue",
          "comment",
          String(number(args[0], "number")),
          ...repo(o),
          "--body",
          text(args[1], "body"),
        ],
        options: options(o),
      };
    }
    case "issueClose": {
      const o = raw(1);
      return {
        args: ["issue", "close", String(number(args[0], "number")), ...repo(o)],
        options: options(o),
      };
    }
    case "prList": {
      const o = raw(0);
      return {
        args: ["pr", "list", ...repo(o), ...state(o), ...limit(o), "--json", prFields],
        options: options(o),
      };
    }
    case "prView": {
      const o = raw(1);
      return {
        args: [
          "pr",
          "view",
          String(number(args[0], "number")),
          ...repo(o),
          "--json",
          `${prFields},body,comments,reviews`,
        ],
        options: options(o),
      };
    }
    case "runList": {
      const o = raw(0);
      return {
        args: ["run", "list", ...repo(o), ...limit(o), "--json", runFields],
        options: options(o),
      };
    }
    case "runView": {
      const o = raw(1);
      return {
        args: [
          "run",
          "view",
          String(number(args[0], "id")),
          ...repo(o),
          "--json",
          `${runFields},jobs`,
        ],
        options: options(o),
      };
    }
    case "releaseView": {
      const o = raw(1);
      return {
        args: [
          "release",
          "view",
          ...(args[0] === undefined || args[0] === null ? [] : [text(args[0], "tag")]),
          ...repo(o),
          "--json",
          "tagName,name,url,isDraft,isPrerelease,publishedAt",
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
        ],
        options: options(o),
      };
    }
    case "api": {
      const o = raw(2);
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
      throw new Error(`Unknown gh method: ${method}`);
  }
}
