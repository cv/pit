import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const fixtures = {
  "run fixture": {
    source: "async () => 2 + 2\n",
    isError: false,
    expectedText: "4",
    reply: "REPLAY_AND_RESULT_OK",
  },
  "run options fixture": {
    source:
      '// @pit: {"label":"Calculate with input","params":2}\nasync ({}, value: number) => value + 2\n',
    isError: false,
    expectedText: "4",
    reply: "REPLAY_AND_RESULT_OK",
  },
  "run invalid fixture": {
    source: "// @pit: {bad}\nasync () => 2\n",
    isError: true,
    expectedText: "must hold a JSON object",
    reply: "INVALID_OPTIONS_REPORTED",
  },
};

export default function (pi) {
  pi.registerProvider("raw-fixture", {
    name: "Raw fixture",
    api: "raw-fixture-api",
    baseUrl: "http://127.0.0.1:1",
    apiKey: "fixture",
    models: [
      {
        id: "fixture",
        name: "fixture",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100000,
        maxTokens: 1000,
      },
    ],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const last = context.messages.at(-1);
        const user = context.messages.findLast((message) => message.role === "user");
        const prompt =
          typeof user?.content === "string"
            ? user.content
            : user?.content
                ?.filter((block) => block.type === "text")
                .map((block) => block.text)
                .join("");
        const fixture = Object.hasOwn(fixtures, prompt)
          ? fixtures[prompt]
          : fixtures["run fixture"];
        const output = {
          role: "assistant",
          content: [],
          api: "openai-codex-responses",
          provider: "openai-codex",
          model: "gpt-6.1-terra",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "toolUse",
          timestamp: Date.now(),
        };
        stream.push({ type: "start", partial: output });
        if (last?.role !== "toolResult") {
          const token = fixture.source.startsWith("//") ? "/" : "a";
          const block = {
            type: "toolCall",
            id: "call_1|fc_1",
            name: "typescript",
            arguments: {},
            argumentsError: `Unexpected token ${token}\n\nReceived arguments:\n${fixture.source}`,
          };
          output.content.push(block);
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: block, partial: output });
        } else {
          const previous = context.messages.findLast(
            (message) =>
              message.role === "assistant" &&
              message.content.some((block) => block.type === "toolCall"),
          );
          const block = previous?.content.find((item) => item.type === "toolCall");
          const expectedResult =
            last.isError === fixture.isError &&
            last.content.some((item) => item.text?.includes(fixture.expectedText));
          const ok =
            block?.arguments?.code === fixture.source && !block?.argumentsError && expectedResult;
          output.content.push({
            type: "text",
            text: ok ? fixture.reply : "REPLAY_OR_RESULT_FAILED",
          });
          output.stopReason = "stop";
        }
        stream.push({ type: "done", reason: output.stopReason, message: output });
        stream.end();
      });
      return stream;
    },
  });
}
