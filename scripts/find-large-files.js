const fs = require('fs');
const path = require('path');

const SKIP_DIRS = [
  'node_modules', '.git', '.claude', 'release',
  'dist', 'dist-electron', '.vscode', '.idea',
  'coverage', '.tmp', 'temp', 'tmp'
];

const SKIP_EXTS = [
  '.test.ts', '.spec.ts', '.test.tsx', '.spec.tsx',
  '.md', '.txt', '.png', '.jpg', '.jpeg', '.ico', '.svg',
  '.json', '.pdf', '.woff', '.woff2', '.ttf', '.eot',
  '.map', '.bak'
];

function shouldSkip(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('/');
  if (parts.some(p => SKIP_DIRS.includes(p))) return true;

  const base = path.basename(filePath);
  if (SKIP_EXTS.some(ext => base.endsWith(ext))) return true;

  return false;
}

function walk(dir, results = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (shouldSkip(fullPath)) continue;

    if (entry.isDirectory()) {
      walk(fullPath, results);
    } else {
      const stat = fs.statSync(fullPath);
      if (stat.size > 40 * 1024) {
        results.push({ path: fullPath, size: stat.size });
      }
    }
  }
  return results;
}

const root = process.argv[2] || process.cwd();
const files = walk(root);
files.sort((a, b) => b.size - a.size);

console.log(`Found ${files.length} files > 40KB (excluding tests/docs/assets):\n`);
for (const f of files) {
  const kb = (f.size / 1024).toFixed(1);
  const rel = path.relative(root, f.path).replace(/\\/g, '/');
  console.log(`${kb.padStart(8)} KB  ${rel}`);
}
