import { defineNativeFunction } from "../native-definition.js";

export const httpFunctions = [
  defineNativeFunction("http", "request", {
    summary: "Request remote data",
    resultRenderer: "http",
    declaration: `request(
  url: string,
  options?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    maxBytes?: number;
  },
): Promise<{
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
}>;`,
    documentation:
      "http.request(url, { maxBytes?, ... }) -> { status, ok, headers, body, truncated }",
    minimumArguments: 1,
    maximumArguments: 2,
  }),
] as const;
