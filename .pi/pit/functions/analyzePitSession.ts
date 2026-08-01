/**
 * Audits a Pi session for recurring tool-call failures and workflow smells.
 * @pit project
 */
async function analyzePitSession(
  { context, shell },
  input: { file?: string; examples?: number } = {},
) {
  const runtime = await context.get();
  const file = input.file ?? runtime.sessionFile;
  if (!file) {
    throw new Error("No Pi session file is available");
  }
  const examples = Math.max(1, Math.min(input.examples ?? 12, 30));
  const script = String.raw`
const fs = require("fs");
const calls = new Map();
const records = [];
const failures = [];
for (const line of fs.readFileSync(process.argv[1], "utf8").split("\n")) {
  if (!line) continue;
  let row;
  try { row = JSON.parse(line); } catch { continue; }
  const message = row.message;
  if (!message) continue;
  for (const part of message.content || []) {
    if (part.type !== "toolCall") continue;
    const args = part.arguments || {};
    const call = { id: part.id, label: args.label || "", code: args.code || "" };
    calls.set(part.id, call);
    records.push(call);
  }
  if (message.role !== "toolResult") continue;
  const call = calls.get(message.toolCallId);
  const text = (message.content || []).map((part) => part.text || "").join("\n");
  if (call && (message.isError || /^(Error:|TypeScript validation failed:|Command failed)/.test(text))) {
    failures.push({ ...call, error: text.split("\n")[0] });
  }
}
const category = (failure) =>
  /Anchor mismatch|anchor references line/i.test(failure.error) ? "anchor" :
  /Revision mismatch/i.test(failure.error) ? "revision" :
  /TypeScript validation failed/i.test(failure.error) ? "typescript" :
  /Command failed/i.test(failure.error) ? "command" : "logic";
const categories = {};
for (const failure of failures) categories[category(failure)] = (categories[category(failure)] || 0) + 1;
const execFilePrograms = {};
for (const record of records) {
  for (const match of record.code.matchAll(/shell\.execFile\(\s*["']([^"']+)/g)) {
    execFilePrograms[match[1]] = (execFilePrograms[match[1]] || 0) + 1;
  }
}
const labels = {};
for (const failure of failures) labels[failure.label] = (labels[failure.label] || 0) + 1;
const limit = Number(process.argv[2]);
console.log(JSON.stringify({
  file: process.argv[1],
  toolCalls: records.length,
  failures: failures.length,
  failureRatePercent: Number((100 * failures.length / Math.max(1, records.length)).toFixed(1)),
  categories,
  execFilePrograms,
  shellExecCalls: records.filter((record) => /shell\.exec\(/.test(record.code)).length,
  promiseAllCalls: records.filter((record) => /Promise\.all/.test(record.code)).length,
  workspaceBatchCalls: records.filter((record) => /workspace\.batch\(/.test(record.code)).length,
  repeatedFailureLabels: Object.entries(labels).sort((a, b) => b[1] - a[1]).slice(0, limit),
  recentFailureExamples: failures.slice(-limit).map((failure) => ({
    category: category(failure),
    label: failure.label,
    error: failure.error,
  })),
}, null, 2));
`;
  const result = await shell.execFile("node", ["-e", script, file, String(examples)], {
    timeoutMs: 30000,
    maxBytes: 50000,
    maxLines: 1000,
    raise: true,
  });
  return JSON.parse(result.stdout);
}
