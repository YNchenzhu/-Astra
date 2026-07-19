const fs = require('fs');
const path = require('path');

const files = [
  'electron/ai/advancedTools.ts',
  'electron/ai/agenticLoop.ts',
  'electron/ai/streamHandler.ts',
  'electron/agents/subAgentRunner.ts',
  'electron/ai/tools.ts',
  'electron/ipc/bundleHandlers.ts',
  'electron/agents/bundles/bundleRegistry.ts',
  'electron/tools/registry.ts',
  'electron/ai/runAgenticToolUse.ts',
  'electron/tools/LSPTool.ts',
  'src/components/AIChat/SettingsDialog.tsx',
  'src/types/index.ts',
  'src/components/Settings/MCPPanel.tsx',
  'src/components/Settings/EmbeddingPanel.tsx',
  'src/components/Sidebar/FileTree.tsx',
];

function analyze(file) {
  const content = fs.readFileSync(file, 'utf-8');
  const lines = content.split('\n');
  const exports = [];
  const functions = [];
  const classes = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Export functions/classes
    const exportMatch = line.match(/^export\s+(?:async\s+)?(?:function|class|const|let|var)\s+(\w+)/);
    if (exportMatch) {
      exports.push({ name: exportMatch[1], line: i + 1, type: exportMatch[0].includes('class') ? 'class' : 'function' });
    }
    // Non-export functions
    const funcMatch = line.match(/^(?:async\s+)?function\s+(\w+)/);
    if (funcMatch && !line.includes('export')) {
      functions.push({ name: funcMatch[1], line: i + 1 });
    }
    // Class definitions
    const classMatch = line.match(/^class\s+(\w+)/);
    if (classMatch && !line.includes('export')) {
      classes.push({ name: classMatch[1], line: i + 1 });
    }
  }

  return {
    file,
    lineCount: lines.length,
    sizeKB: (fs.statSync(file).size / 1024).toFixed(1),
    exports,
    functions: functions.slice(0, 20), // limit output
    classes: classes.slice(0, 10),
  };
}

console.log('=== Large File Analysis ===\n');
for (const f of files) {
  const full = path.join(process.cwd(), f);
  if (!fs.existsSync(full)) {
    console.log(`SKIP (not found): ${f}`);
    continue;
  }
  const a = analyze(full);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`FILE: ${a.file}`);
  console.log(`Lines: ${a.lineCount}  |  Size: ${a.sizeKB} KB`);
  console.log(`\nExported symbols (${a.exports.length}):`);
  a.exports.forEach(e => console.log(`  ${e.type} ${e.name} (line ${e.line})`));
  if (a.classes.length) {
    console.log(`\nClasses (${a.classes.length}):`);
    a.classes.forEach(c => console.log(`  class ${c.name} (line ${c.line})`));
  }
  if (a.functions.length) {
    console.log(`\nTop internal functions (${a.functions.length}):`);
    a.functions.forEach(fn => console.log(`  function ${fn.name} (line ${fn.line})`));
  }
}
