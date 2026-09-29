import { Type } from "typebox";

import { CLOSED, shapeGuard } from "../shared/shape-guard.js";
import { renderStructuredData } from "./compound.js";
import { parseCompleteJson } from "./shared.js";
import type { RenderContext, RenderedResultValue } from "./types.js";

const isHttpResponse = shapeGuard(
  Type.Object(
    {
      status: Type.Number(),
      ok: Type.Boolean(),
      headers: Type.Record(Type.String(), Type.String()),
      body: Type.String(),
      truncated: Type.Boolean(),
    },
    CLOSED,
  ),
);

export function renderHttp(
  value: unknown,
  { theme }: RenderContext,
): RenderedResultValue | undefined {
  if (!isHttpResponse(value)) return;

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
    const jsonContentType = contentType?.toLowerCase().includes("json") === true;
    // Keep malformed, mislabeled, or truncated response bodies as text.
    const parsed = parseCompleteJson(value.body, {
      truncated: value.truncated,
      requireContainer: !jsonContentType,
    });
    lines.push(
      ...(parsed === undefined
        ? value.body.split("\n")
        : renderStructuredData(parsed, { theme }).lines),
    );
  } else {
    lines.push(theme.fg("dim", "(empty body)"));
  }
  return {
    kind: "http",
    outcome: !value.ok ? "error" : value.truncated ? "warning" : "success",
    lines,
    summary: state,
    detailLines: lines.slice(1),
  };
}
