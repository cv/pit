import { isRecord } from "../shared/records.js";

const PREFIX = "// @pit:";
const OPTIONS_LINE = /^[ \t]*\/\/ @pit:([^\r\n]*)(\r?\n|$)/;
const OPTION_KEYS = ["label", "functionId", "params", "saveOnly", "timeoutMs"];

/**
 * Lark grammar for providers with grammar-constrained tool input, which send the program as raw
 * text in `code`. An optional first line carries the tool's other arguments as JSON. It only fixes
 * the shape of that line; {@link applySourceOptions} checks its JSON. It has the shape of Pi's
 * codemode grammar, which grammar-capable providers already accept.
 */
export const PIT_SOURCE_GRAMMAR = String.raw`
start: options_source | plain_source
options_source: OPTIONS_LINE NEWLINE SOURCE
plain_source: SOURCE

OPTIONS_LINE: /[ \t]*\/\/ @pit:[^\r\n]*/
NEWLINE: /\r?\n/
SOURCE: /[\s\S]+/
`;

/**
 * Moves a leading `// @pit: {...}` line of the source into the tool's other arguments. The line
 * becomes an empty one, so diagnostics keep the line numbers of the source as written.
 */
export function applySourceOptions(args: unknown): unknown {
  if (!isRecord(args) || typeof args.code !== "string") return args;
  const match = OPTIONS_LINE.exec(args.code);
  if (!match) return args;
  let options: unknown;
  try {
    options = JSON.parse(match[1] ?? "");
  } catch (error) {
    throw new Error(`The ${PREFIX} line must hold a JSON object: ${(error as Error).message}`, {
      cause: error,
    });
  }
  if (!isRecord(options)) throw new Error(`The ${PREFIX} line must hold a JSON object`);
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.includes(key)) {
      throw new Error(`Unknown ${PREFIX} option "${key}"; use ${OPTION_KEYS.join(", ")}`);
    }
    if (args[key] !== undefined && args[key] !== null) {
      throw new Error(`"${key}" is set both as an argument and on the ${PREFIX} line`);
    }
  }
  return { ...args, ...options, code: `\n${args.code.slice(match[0].length)}` };
}
