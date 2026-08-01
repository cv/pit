import type { RenderContext, RenderedResultValue } from "../result-renderer-types.js";
import {
  hasOnlyKeys,
  isRecord,
  isStringRecord,
  JSON_CONTAINER_PREFIX,
  renderJson,
} from "./shared.js";

export function renderHttp(
  value: unknown,
  { theme }: RenderContext,
): RenderedResultValue | undefined {
  if (
    !(isRecord(value) && hasOnlyKeys(value, ["status", "ok", "headers", "body", "truncated"])) ||
    typeof value.status !== "number" ||
    typeof value.ok !== "boolean" ||
    !isStringRecord(value.headers) ||
    typeof value.body !== "string" ||
    typeof value.truncated !== "boolean"
  ) {
    return;
  }

  const state = [`HTTP ${value.status}`, value.truncated ? "truncated" : ""]
    .filter(Boolean)
    .join(", ");
  const lines = [theme.fg(value.ok ? "success" : "error", theme.bold(state))];
  const headers = Object.entries(value.headers);
  if (headers.length > 0) {
    lines.push(theme.fg("accent", "headers"));
    lines.push(
      ...headers.map(([name, headerValue]) => `${theme.fg("dim", `${name}:`)} ${headerValue}`),
    );
  }
  if (value.body) {
    lines.push(theme.fg("accent", "body"));
    const contentType = Object.entries(value.headers).find(
      ([name]) => name.toLowerCase() === "content-type",
    )?.[1];
    const shouldParseJson =
      contentType?.toLowerCase().includes("json") === true ||
      JSON_CONTAINER_PREFIX.test(value.body);
    let bodyLines = value.body.split("\n");
    if (shouldParseJson) {
      try {
        bodyLines = renderJson(JSON.parse(value.body));
      } catch {
        // Keep malformed or mislabeled response bodies as text.
      }
    }
    lines.push(...bodyLines);
  } else {
    lines.push(theme.fg("dim", "(empty body)"));
  }
  return { kind: "http", lines, summary: state, detailLines: lines.slice(1) };
}
