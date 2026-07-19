import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import * as ts from 'typescript'

const electronRoot = path.resolve(process.cwd(), 'electron')

function productionTypeScriptFiles(dir = electronRoot): string[] {
  const files: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue
      files.push(...productionTypeScriptFiles(full))
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !full.includes(`${path.sep}__tests__${path.sep}`)
    ) {
      files.push(full)
    }
  }
  return files
}

function parseTypeScript(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
}

function importedLocalNames(sourceFile: ts.SourceFile, exportedName: string): Set<string> {
  const names = new Set<string>()
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue
    const bindings = statement.importClause?.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) continue
    for (const specifier of bindings.elements) {
      const imported = specifier.propertyName?.text ?? specifier.name.text
      if (imported === exportedName) names.add(specifier.name.text)
    }
  }
  return names
}

function callsImportedBinding(sourceFile: ts.SourceFile, exportedName: string): boolean {
  const localNames = importedLocalNames(sourceFile, exportedName)
  let found = false
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      localNames.has(node.expression.text)
    ) {
      found = true
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return found
}

describe('orchestration architecture contracts', () => {
  it('keeps raw AgentLoop imports inside the low-level driver boundary', () => {
    const allowed = new Set([
      path.normalize('electron/ai/agenticLoopAsync.ts'),
      path.normalize('electron/orchestration/hostedAgentLoop.ts'),
      path.normalize('electron/orchestration/phases/callModel.ts'),
    ])
    const violations: string[] = []
    for (const file of productionTypeScriptFiles()) {
      const source = fs.readFileSync(file, 'utf8')
      const sourceFile = parseTypeScript(file)
      const rawCall =
        callsImportedBinding(sourceFile, 'runAgenticLoop') ||
        callsImportedBinding(sourceFile, 'runAgenticLoopAsync') ||
        /import\s*\([^)]*\)[\s\S]{0,200}\b(?:runAgenticLoop|runAgenticLoopAsync)\b/.test(source)
      if (!rawCall) continue
      const relative = path.normalize(path.relative(process.cwd(), file))
      if (!allowed.has(relative)) violations.push(relative)
    }
    expect(violations).toEqual([])
  })

  it('allows production RuntimeState registration only in the admission coordinator', () => {
    const violations: string[] = []
    for (const file of productionTypeScriptFiles()) {
      const relative = path.normalize(path.relative(process.cwd(), file))
      if (
        relative === path.normalize('electron/orchestration/toolRuntime/admission.ts') ||
        relative === path.normalize('electron/orchestration/toolRuntime/state.ts')
      ) {
        continue
      }
      if (callsImportedBinding(parseTypeScript(file), 'registerToolInvocation')) {
        violations.push(relative)
      }
    }
    expect(violations).toEqual([])
  })

  it('derives worker termination validation from the shared runtime constant', () => {
    const wire = fs.readFileSync(
      path.join(electronRoot, 'bridge', 'sessionMessages.ts'),
      'utf8',
    )
    const runtime = fs.readFileSync(
      path.join(electronRoot, 'ai', 'queryTermination.ts'),
      'utf8',
    )
    expect(wire).toContain('z.enum(KNOWN_TERMINATION_REASONS)')
    expect(runtime).toContain("from '../../shared/terminationReasons'")
  })

  it('has no transitional transcript callbacks or direct transcript-field assignment', () => {
    const violations: string[] = []
    for (const file of productionTypeScriptFiles()) {
      const relative = path.normalize(path.relative(process.cwd(), file))
      const source = fs.readFileSync(file, 'utf8')
      if (/\b(?:orchestratedTranscriptSync|kernelInboxDrain)\b/.test(source)) {
        violations.push(`${relative}: legacy callback`)
      }
      if (
        relative !== path.normalize('electron/orchestration/sessionCommands.ts') &&
        /\.(?:transcript|transcriptRevision|transcriptFingerprint)\s*=(?!=)/.test(source)
      ) {
        violations.push(`${relative}: direct transcript assignment`)
      }
    }
    expect(violations).toEqual([])
  })

  it('allows scheduler enqueue only inside the admission coordinator', () => {
    const violations: string[] = []
    for (const file of productionTypeScriptFiles()) {
      const relative = path.normalize(path.relative(process.cwd(), file))
      if (relative === path.normalize('electron/orchestration/toolRuntime/admission.ts')) continue
      const source = fs.readFileSync(file, 'utf8')
      if (/\.enqueueBatch\s*\(/.test(source)) violations.push(relative)
    }
    expect(violations).toEqual([])
  })

  it('emits task termination from the Kernel final AgenticLoopResult callback', () => {
    const streamHandler = fs.readFileSync(
      path.join(electronRoot, 'ai', 'streamHandler.ts'),
      'utf8',
    )
    const kernel = fs.readFileSync(path.join(electronRoot, 'orchestration', 'kernel.ts'), 'utf8')
    expect(streamHandler).not.toContain('registerTerminationCleanup')
    expect(streamHandler).toContain('onTerminate: emitTaskTerminated')
    expect(kernel).toContain('params.onTerminate?.(lastOutcome)')
    expect(kernel).toContain('terminationReason: lastOutcome.terminationResult.reason')
  })
})
