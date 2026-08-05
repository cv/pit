import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";

import ts from "typescript";

const ROOTS = ["src", "test", "scripts"];
const THRESHOLDS = {
  sourceFileLines: 400,
  sourceFunctionLines: 100,
  testCaseLines: 150,
  complexity: 20,
};
const MAX_REPORTED = 50;
const LINE_BREAK = /\r?\n/;
const TEST_CASE_NAME = /^(?:it|test):/;

function sourceFiles() {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(file);
      } else if ([".ts", ".mts", ".mjs"].includes(extname(file)) && !file.endsWith(".d.ts")) {
        files.push(file);
      }
    }
  };
  for (const root of ROOTS) {
    visit(root);
  }
  return files.sort();
}

function isFunction(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function functionName(node, sourceFile) {
  if (node.name?.getText) {
    return node.name.getText(sourceFile);
  }
  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent)) {
    return parent.name.getText(sourceFile);
  }
  if (parent && ts.isCallExpression(parent)) {
    const first = parent.arguments[0];
    if (first && ts.isStringLiteral(first)) {
      return `${parent.expression.getText(sourceFile)}: ${first.text}`;
    }
    return `${parent.expression.getText(sourceFile)} callback`;
  }
  return "<anonymous>";
}

function branchComplexity(node) {
  let score = 1;
  const visit = (current) => {
    if (
      ts.isIfStatement(current) ||
      ts.isForStatement(current) ||
      ts.isForInStatement(current) ||
      ts.isForOfStatement(current) ||
      ts.isWhileStatement(current) ||
      ts.isDoStatement(current) ||
      ts.isCaseClause(current) ||
      ts.isCatchClause(current) ||
      ts.isConditionalExpression(current)
    ) {
      score++;
    }
    if (
      ts.isBinaryExpression(current) &&
      [
        ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken,
      ].includes(current.operatorToken.kind)
    ) {
      score++;
    }
    ts.forEachChild(current, visit);
  };
  if (node.body) {
    visit(node.body);
  }
  return score;
}

export function auditProject() {
  const findings = [];
  for (const file of sourceFiles()) {
    const text = readFileSync(file, "utf8");
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const fileLines = text.split(LINE_BREAK).length;
    if (file.startsWith("src/") && fileLines > THRESHOLDS.sourceFileLines) {
      findings.push({ kind: "source-file", file, name: "", lines: fileLines, score: 0 });
    }
    const visit = (node) => {
      if (isFunction(node)) {
        const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        const end = sourceFile.getLineAndCharacterOfPosition(node.end).line + 1;
        const lines = end - start + 1;
        const score = branchComplexity(node);
        const name = functionName(node, sourceFile);
        const isTestCase = file.startsWith("test/") && TEST_CASE_NAME.test(name);
        if (file.startsWith("src/") && lines > THRESHOLDS.sourceFunctionLines) {
          findings.push({ kind: "source-function", file, name, lines, score });
        }
        if (isTestCase && lines > THRESHOLDS.testCaseLines) {
          findings.push({ kind: "test-case", file, name, lines, score });
        }
        if (file.startsWith("src/") && score > THRESHOLDS.complexity) {
          findings.push({ kind: "complexity", file, name, lines, score });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return findings
    .sort(
      (left, right) =>
        left.kind.localeCompare(right.kind) ||
        right.lines - left.lines ||
        right.score - left.score ||
        left.file.localeCompare(right.file),
    )
    .slice(0, MAX_REPORTED);
}

const findings = auditProject();
let output;
if (process.argv.includes("--json")) {
  output = JSON.stringify({ thresholds: THRESHOLDS, findings }, null, 2);
} else {
  const lines = [
    "Pit maintainability audit (soft warnings)",
    `Thresholds: ${JSON.stringify(THRESHOLDS)}`,
  ];
  for (const finding of findings) {
    const name = finding.name ? ` :: ${finding.name}` : "";
    lines.push(
      `- ${finding.kind}: ${relative(process.cwd(), finding.file)}${name} (${finding.lines} lines, score ${finding.score})`,
    );
  }
  lines.push(`${findings.length} finding(s); generated and declaration files are excluded.`);
  output = lines.join("\n");
}
process.stdout.write(`${output}\n`);
