#!/usr/bin/env node

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));

if (!args.dir) {
  fail("Missing required --dir argument.");
}

if (args.mustContain.length === 0 && args.mustNotContain.length === 0) {
  fail("Provide at least one --must-contain or --must-not-contain argument.");
}

const rootDir = path.resolve(args.dir);
const matches = {
  required: new Map(args.mustContain.map((term) => [term, []])),
  forbidden: new Map(args.mustNotContain.map((term) => [term, []]))
};

await scan(rootDir);

let hasFailure = false;

for (const [term, files] of matches.forbidden.entries()) {
  if (files.length > 0) {
    hasFailure = true;
    console.error(`Forbidden string found: ${term}`);
    for (const file of files) {
      console.error(`  ${file}`);
    }
  }
}

for (const [term, files] of matches.required.entries()) {
  if (files.length === 0) {
    hasFailure = true;
    console.error(`Required string not found: ${term}`);
  } else {
    console.log(`Required string found: ${term}`);
    for (const file of files) {
      console.log(`  ${file}`);
    }
  }
}

if (hasFailure) {
  process.exit(1);
}

console.log("Web bundle API base check passed.");

async function scan(currentPath) {
  const currentStat = await stat(currentPath);

  if (currentStat.isDirectory()) {
    if (shouldSkipDirectory(currentPath)) {
      return;
    }

    const entries = await readdir(currentPath);
    for (const entry of entries) {
      await scan(path.join(currentPath, entry));
    }
    return;
  }

  if (!currentStat.isFile() || shouldSkipFile(currentPath, currentStat.size)) {
    return;
  }

  const buffer = await readFile(currentPath);
  if (looksBinary(buffer)) {
    return;
  }

  const text = buffer.toString("utf8");
  const relativePath = path.relative(process.cwd(), currentPath);

  for (const [term, files] of matches.required.entries()) {
    if (text.includes(term)) {
      files.push(relativePath);
    }
  }

  for (const [term, files] of matches.forbidden.entries()) {
    if (text.includes(term)) {
      files.push(relativePath);
    }
  }
}

function parseArgs(rawArgs) {
  const parsed = {
    dir: "",
    mustContain: [],
    mustNotContain: []
  };

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    const next = rawArgs[index + 1];

    if (arg === "--dir") {
      parsed.dir = readValue(arg, next);
      index += 1;
      continue;
    }

    if (arg === "--must-contain") {
      parsed.mustContain.push(readValue(arg, next));
      index += 1;
      continue;
    }

    if (arg === "--must-not-contain") {
      parsed.mustNotContain.push(readValue(arg, next));
      index += 1;
      continue;
    }

    fail(`Unknown argument: ${arg}`);
  }

  return parsed;
}

function readValue(arg, value) {
  if (!value || value.startsWith("--")) {
    fail(`${arg} requires a value.`);
  }
  return value;
}

function shouldSkipDirectory(directoryPath) {
  const name = path.basename(directoryPath);
  return [".git", "node_modules"].includes(name);
}

function shouldSkipFile(filePath, size) {
  if (size > 25 * 1024 * 1024) {
    return true;
  }

  const extension = path.extname(filePath).toLowerCase();
  return new Set([
    ".avif",
    ".bmp",
    ".br",
    ".gif",
    ".gz",
    ".ico",
    ".jpeg",
    ".jpg",
    ".png",
    ".ttf",
    ".webp",
    ".woff",
    ".woff2",
    ".zip"
  ]).has(extension);
}

function looksBinary(buffer) {
  const sampleLength = Math.min(buffer.length, 8000);
  for (let index = 0; index < sampleLength; index += 1) {
    if (buffer[index] === 0) {
      return true;
    }
  }
  return false;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
