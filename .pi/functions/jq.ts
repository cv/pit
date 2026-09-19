/**
 * Queries a JSON/JSONL file with jq and returns parsed JSON values, never partial output.
 * Requires jq on PATH. Filters and variables are passed as arguments, not shell source.
 *
 * @param input.variables - Primitive JSON bindings available as $name in the filter.
 * @param input.rawInput - Read lines as strings (jq -R), useful for tolerant JSONL parsing.
 * @param input.nullInput - Start with null (jq -n); the filter can consume the file via inputs.
 */
async function jq(
  { shell: { execFile } },
  input: {
    file: string;
    filter: string;
    variables?: Record<string, string | number | boolean | null>;
    rawInput?: boolean;
    nullInput?: boolean;
  },
) {
  type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
  if (!input.file || input.file.includes("\0") || !input.filter.trim()) {
    throw new Error("jq requires a non-empty file path and filter");
  }
  const args = ["--compact-output", "--monochrome-output"];
  if (input.rawInput) args.push("--raw-input");
  if (input.nullInput) args.push("--null-input");
  for (const [name, value] of Object.entries(input.variables ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`Invalid jq variable name: ${name}`);
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`jq variable ${name} must be finite`);
    }
    args.push("--argjson", name, JSON.stringify(value));
  }
  // A literal file named '-' must not become stdin, even after '--'.
  const file = input.file.startsWith("/") ? input.file : `./${input.file}`;
  args.push("--", input.filter, file);
  const result = await execFile("jq", args, {
    raise: false,
    timeoutMs: 30000,
    maxBytes: 50000,
    maxLines: 2000,
  });
  if (result.code !== 0) {
    throw new Error(`jq failed (exit ${result.code}): ${result.stderr.slice(-4000)}`);
  }
  if (result.truncated) {
    throw new Error("jq output was truncated; reduce or page the query before retrying");
  }
  try {
    const values = result.stdout.trim()
      ? result.stdout
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as JsonValue)
      : [];
    return { values };
  } catch {
    throw new Error("jq returned invalid JSON output");
  }
}
