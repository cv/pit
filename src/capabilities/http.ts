import { defineCapability } from "../capability-core.js";

export const httpCapability = defineCapability({
  interfaceName: "PitHttpCapability",
  methods: {
    request: {
      callDescription: "Request remote data",
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
    },
  },
});
