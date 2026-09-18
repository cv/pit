export interface PromptMetadata {
  description: string;
  promptSnippet?: string;
  promptGuidelines?: readonly string[];
  parameters: object;
}

export function textSize(text: string) {
  return { characters: text.length, bytes: Buffer.byteLength(text) };
}

export function schemaDescriptions(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) =>
    key === "description" && typeof child === "string" ? [child] : schemaDescriptions(child),
  );
}

/** Fixed Pit prose only; excludes dynamic additions and Pi/provider formatting. */
export function measurePrompt(metadata: PromptMetadata) {
  const parts = {
    description: metadata.description,
    guidelines: metadata.promptGuidelines?.join("\n") ?? "",
    snippet: metadata.promptSnippet ?? "",
    parameterDescriptions: schemaDescriptions(metadata.parameters).join(""),
  };
  return {
    parts: Object.fromEntries(Object.entries(parts).map(([name, text]) => [name, textSize(text)])),
    fixed: textSize(Object.values(parts).join("")),
    // Diagnostic only: descriptions already contribute to fixed. Do not add this to fixed.
    serializedSchema: textSize(JSON.stringify(metadata.parameters)),
  };
}
