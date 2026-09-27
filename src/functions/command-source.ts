import { readFileSync } from "node:fs";

import ts from "typescript";

import { defineGlobalSourceFunction, type GlobalFunctionInput } from "./global-definition.js";

// Package-owned pure modules, embedded as local declarations in inspectable source functions.
// No module is executed on the host. Dependencies on host effects are injected normally.
function declarations(path: string): string {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  return file.statements
    .filter((statement) => !ts.isImportDeclaration(statement))
    .map((statement) => statement.getText(file).replace(/^export /, ""))
    .join("\n");
}

const argumentSource = declarations("../shared/argument-values.ts");
const commandSources = {
  git: `function prepareGitCommand(method: string, args: unknown[]) {
    return {
      args: [method, ...(args[0] === undefined ? [] : stringArrayValue(args[0], "args"))],
      options: args[1] === undefined ? {} : recordValue(args[1], "options"),
    };
  }`,
  npm: `const object = recordValue, string = stringValue, stringArray = stringArrayValue;\n${declarations("./commands/npm.ts")}`,
  gh: `const object = recordValue, text = stringValue, list = stringArrayValue;\n${declarations("./commands/gh.ts")}`,
};

/** Assemble a self-contained source function; only shell.execFile crosses the host boundary. */
export function defineCommandFunction<
  const Namespace extends keyof typeof commandSources,
  const Method extends string,
>(namespace: Namespace, method: Method, metadata: GlobalFunctionInput) {
  const title = namespace.charAt(0).toUpperCase() + namespace.slice(1);
  const range =
    metadata.minimumArguments === metadata.maximumArguments
      ? String(metadata.minimumArguments)
      : `${metadata.minimumArguments}-${metadata.maximumArguments}`;
  const diagnostic = JSON.stringify(
    `${namespace}.${method} expects ${range} argument(s); received `,
  );
  const source = `async function ${method}({ shell: { execFile } }, ...args: Parameters<Pit${title}Capability[${JSON.stringify(method)}]>): Promise<PitProcessResult> {
    if (args.length < ${metadata.minimumArguments} || args.length > ${metadata.maximumArguments}) {
      throw new Error(${diagnostic} + args.length);
    }
    ${argumentSource}
    ${commandSources[namespace]}
    const command = prepare${title}Command(${JSON.stringify(method)}, args);
    return execFile(${JSON.stringify(namespace)}, command.args, command.options as PitProcessOptions);
  }`;
  return defineGlobalSourceFunction(namespace, method, metadata, source);
}
