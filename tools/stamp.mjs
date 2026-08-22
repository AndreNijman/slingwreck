#!/usr/bin/env node

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['.git', 'node_modules', 'shots']);
const STAMP_PATTERN = /^\d{8}-[1-9]\d*$/;
const STAMP_FINDER = /\?v=(\d{8}-\d+)/g;

function sourceFiles(directory, files = []) {
  for (const name of readdirSync(directory)) {
    if (SKIP.has(name)) continue;
    const path = join(directory, name);
    const stat = statSync(path);
    if (stat.isDirectory()) sourceFiles(path, files);
    else if (path === join(ROOT, 'index.html') || ['.js', '.mjs'].includes(extname(path))) {
      files.push(path);
    }
  }
  return files;
}

function localDate() {
  const now = new Date();
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}` +
    `${String(now.getDate()).padStart(2, '0')}`;
}

function nextStamp(files) {
  const date = localDate();
  let serial = 0;
  for (const path of files) {
    const source = readFileSync(path, 'utf8');
    for (const [, stamp] of source.matchAll(STAMP_FINDER)) {
      if (stamp.startsWith(`${date}-`)) {
        serial = Math.max(serial, Number.parseInt(stamp.slice(9), 10));
      }
    }
  }
  return `${date}-${serial + 1}`;
}

function stampModules(source, stamp) {
  return source.replace(
    /(\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(['"])((?:\.\.?\/|\/)[^'"?]+\.(?:js|mjs))(?:\?v=\d{8}-\d+)?\2/g,
    (_match, prefix, quote, specifier) => `${prefix}${quote}${specifier}?v=${stamp}${quote}`
  );
}

function stampHtml(source, stamp) {
  return source.replace(
    /(<(?:link|script)\b[^>]*\b(?:href|src)=)(['"])(\.?\/?[^'"?]+\.(?:css|js))(?:\?v=\d{8}-\d+)?\2/gi,
    (_match, prefix, quote, specifier) => `${prefix}${quote}${specifier}?v=${stamp}${quote}`
  );
}

const requested = process.argv[2];
if (process.argv.length > 3 || requested && !STAMP_PATTERN.test(requested)) {
  console.error('usage: node tools/stamp.mjs [YYYYMMDD-N]');
  process.exit(1);
}

const files = sourceFiles(ROOT).sort();
const stamp = requested ?? nextStamp(files);
const rewrites = [];

for (const path of files) {
  const source = readFileSync(path, 'utf8');
  const updated = path === join(ROOT, 'index.html')
    ? stampHtml(source, stamp)
    : stampModules(source, stamp);
  if (updated !== source) rewrites.push({ path, updated });
}

for (const rewrite of rewrites) writeFileSync(rewrite.path, rewrite.updated);

console.log(`set cache stamp ${stamp} in ${rewrites.length} file${rewrites.length === 1 ? '' : 's'}`);
for (const rewrite of rewrites) console.log(`  ${relative(ROOT, rewrite.path)}`);
