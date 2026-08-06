import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";

import ts from "typescript";

const ROOT = resolve("src");
const MAX_ROOT_SOURCE_FILES = 15;
const SOURCE_EXTENSIONS = new Set([".ts", ".mjs"]);

function sourceFiles() {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (SOURCE_EXTENSIONS.has(extname(file)) && !file.endsWith(".d.ts")) files.push(file);
    }
  };
  visit(ROOT);
  return files.sort();
}

function importedTarget(file, specifier, files) {
  if (!specifier.startsWith(".")) return undefined;
  const target = resolve(dirname(file), specifier);
  const candidates = [target, target.replace(/\.js$/, ".ts")];
  return candidates.find((candidate) => files.has(candidate));
}

function importGraph(files) {
  const available = new Set(files);
  return new Map(
    files.map((file) => {
      const imports = ts.preProcessFile(readFileSync(file, "utf8")).importedFiles;
      const targets = imports
        .map(({ fileName }) => importedTarget(file, fileName, available))
        .filter((target) => target !== undefined);
      return [file, [...new Set(targets)]];
    }),
  );
}

function cyclicComponents(graph) {
  let index = 0;
  const indexes = new Map();
  const lowLinks = new Map();
  const stack = [];
  const active = new Set();
  const components = [];
  const visit = (file) => {
    indexes.set(file, index);
    lowLinks.set(file, index);
    index++;
    stack.push(file);
    active.add(file);
    for (const target of graph.get(file) ?? []) {
      if (!indexes.has(target)) {
        visit(target);
        lowLinks.set(file, Math.min(lowLinks.get(file), lowLinks.get(target)));
      } else if (active.has(target)) {
        lowLinks.set(file, Math.min(lowLinks.get(file), indexes.get(target)));
      }
    }
    if (lowLinks.get(file) !== indexes.get(file)) return;
    const component = [];
    let current;
    do {
      current = stack.pop();
      active.delete(current);
      component.push(current);
    } while (current !== file);
    if (component.length > 1) components.push(component.sort());
  };
  for (const file of graph.keys()) if (!indexes.has(file)) visit(file);
  return components.sort((left, right) => right.length - left.length);
}

const files = sourceFiles();
const rootFiles = files.filter((file) => dirname(file) === ROOT);
const cycles = cyclicComponents(importGraph(files));
const failures = [];
if (rootFiles.length > MAX_ROOT_SOURCE_FILES) {
  failures.push(
    `src/ contains ${rootFiles.length} source files; maximum is ${MAX_ROOT_SOURCE_FILES}`,
  );
}
for (const cycle of cycles) {
  failures.push(`import cycle: ${cycle.map((file) => relative(process.cwd(), file)).join(" -> ")}`);
}
if (failures.length > 0) {
  process.stderr.write(`Pit structure check failed:\n- ${failures.join("\n- ")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Pit structure check passed (${rootFiles.length}/${MAX_ROOT_SOURCE_FILES} root source files, 0 import cycles).\n`,
  );
}
