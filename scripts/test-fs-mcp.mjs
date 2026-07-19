#!/usr/bin/env node
/**
 * 系统性测试 @modelcontextprotocol/server-filesystem 每个工具的参数传递问题
 * 
 * 运行方式：node scripts/test-fs-mcp.mjs
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'
import os from 'os'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '..')

// ── 准备工作 ──────────────────────────────────────────────────────────────
const TEST_DIR = path.join(os.tmpdir(), `fs-mcp-test-${Date.now()}`)
fs.mkdirSync(TEST_DIR, { recursive: true })

// 创建测试用文件和目录
const TEST_FILE_A = path.join(TEST_DIR, 'alpha.txt')
const TEST_FILE_B = path.join(TEST_DIR, 'beta.txt')
const TEST_FILE_MEDIA = path.join(TEST_DIR, 'test.png')
const TEST_SUBDIR = path.join(TEST_DIR, 'sub')
const TEST_EMPTY_DIR = path.join(TEST_DIR, 'empty')
const TEST_LINK = path.join(TEST_DIR, 'alpha-link.txt')
const TEST_SYMLINK_DIR = path.join(TEST_DIR, 'symlink-dir')
const TEST_OUTSIDE_LINK = path.join(TEST_DIR, 'outside-link')
fs.writeFileSync(TEST_FILE_A, 'line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\nline 10\n')
fs.writeFileSync(TEST_FILE_B, 'hello world')
// 创建假 png（1x1 像素最小 PNG）
const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
fs.writeFileSync(TEST_FILE_MEDIA, pngBytes)
fs.mkdirSync(TEST_SUBDIR, { recursive: true })
fs.writeFileSync(path.join(TEST_SUBDIR, 'nested.txt'), 'nested content')
fs.mkdirSync(TEST_EMPTY_DIR, { recursive: true })

// Windows symlink (需要管理员权限或开发者模式)
if (process.platform === 'win32') {
  try {
    fs.symlinkSync(TEST_FILE_A, TEST_LINK, 'file')
  } catch { /* 忽略 */ }
  try {
    fs.symlinkSync(TEST_SUBDIR, TEST_SYMLINK_DIR, 'dir')
  } catch { /* 忽略 */ }
} else {
  try {
    fs.symlinkSync(TEST_FILE_A, TEST_LINK)
  } catch { /* 忽略 */ }
  try {
    fs.symlinkSync(TEST_SUBDIR, TEST_SYMLINK_DIR)
  } catch { /* 忽略 */ }
}

// ── MCP 客户端 ────────────────────────────────────────────────────────────
const client = new Client({ name: 'test-fs-mcp', version: '1.0.0' })
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(PROJECT_ROOT, 'node_modules/@modelcontextprotocol/server-filesystem/dist/index.js'), TEST_DIR],
  stderr: 'pipe',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
})

// 捕获 stderr
if (transport.stderr) {
  transport.stderr.on('data', (chunk) => {
    // silent
  })
}

let passed = 0
let failed = 0
let warnings = []

function report(label, test, result, detail) {
  if (result === 'PASS') {
    console.log(`  ✅ ${label}`)
    passed++
  } else if (result === 'WARN') {
    console.log(`  ⚠️  ${label}${detail ? ' — ' + detail : ''}`)
    failed++
    warnings.push(label)
  } else {
    console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`)
    failed++
  }
  if (test) {
    console.log(`      参数: ${JSON.stringify(test).slice(0, 200)}`)
  }
}

async function callTool(toolName, args) {
  const result = await client.callTool({ name: toolName, arguments: args })
  // 提取文本内容
  const text = (result.content || [])
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('\n')
  return { result, text }
}

async function expectFail(label, toolName, args, expectedMsg) {
  try {
    const { text } = await callTool(toolName, args)
    if (text.includes(expectedMsg || '')) {
      report(label, args, 'PASS')
    } else {
      report(label, args, 'FAIL', `期望失败但成功了 => ${text.slice(0, 100)}`)
    }
  } catch (e) {
    const msg = e.message || String(e)
    if (expectedMsg && msg.includes(expectedMsg)) {
      report(label, args, 'PASS')
    } else {
      report(label, args, 'FAIL', `错误信息不符: ${msg.slice(0, 100)}`)
    }
  }
}

async function expectOk(label, toolName, args, contains) {
  try {
    const { text } = await callTool(toolName, args)
    if (contains && !text.includes(contains)) {
      report(label, args, 'FAIL', `缺少 "${contains}" => ${text.slice(0, 100)}`)
    } else {
      report(label, args, 'PASS')
    }
  } catch (e) {
    report(label, args, 'FAIL', `异常: ${e.message.slice(0, 100)}`)
  }
}

// ── 连接 MCP 服务器 ─────────────────────────────────────────────────────────
console.log('正在连接 filesystem MCP 服务器...')
await client.connect(transport)
console.log('已连接!\n')

// ── 快速补测边缘用例 ──────────────────────────────────────────────────────

// 辅助: 检查 callTool 结果(包括 isError=true 的文本返回)
async function callRaw(toolName, args) {
  try {
    const result = await client.callTool({ name: toolName, arguments: args })
    const isError = result.isError === true
    const text = (result.content || [])
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('\n')
    return { result, text, isError }
  } catch (e) {
    return { error: e.message, isError: true, text: '' }
  }
}

console.log('\n━━━ 额外边缘测试 ━━━')

// A. tail/head 负数/零返回值
const { text: tA1 } = await callRaw('read_text_file', { path: path.join(TEST_DIR, 'alpha.txt'), tail: 0 })
report('A01 tail=0 返回空字符串', {}, tA1 === '' ? 'WARN' : 'PASS', tA1 === '' ? 'Zod 未拒绝 tail=0,返回空字符串,LLM 可能困惑为何没拿到内容' : '')

const { text: tA2 } = await callRaw('read_text_file', { path: path.join(TEST_DIR, 'alpha.txt'), tail: -5 })
report('A02 tail=-5 返回空字符串', {}, tA2 === '' ? 'WARN' : 'PASS', tA2 === '' ? 'Zod 未拒绝负数,返回空字符串,无错误提示' : '')

const { text: tA3, isError: eA3 } = await callRaw('read_text_file', { path: path.join(TEST_DIR, 'alpha.txt'), tail: 3.5 })
report('A03 tail=3.5(浮点数)', {}, eA3 ? 'PASS' : 'WARN', !eA3 ? `Zod 接受浮点数 tail=${3.5},应拒绝` : '')

const { text: tA4, isError: eA4 } = await callRaw('read_text_file', { path: path.join(TEST_DIR, 'alpha.txt'), tail: '5' })
report('A04 tail="5"(字符串→数字)', {}, eA4 ? 'PASS' : 'WARN', !eA4 ? 'Zod 接受字符串 tail="5",未做类型强制' : '')

// B. create_directory 递归创建
const deepDir = path.join(TEST_DIR, 'x', 'y', 'z')
const { isError: eB1, text: tB1 } = await callRaw('create_directory', { path: deepDir })
report('B01 创建嵌套目录 x/y/z', {}, !eB1 ? 'PASS' : 'FAIL', tB1.slice(0, 100))

// C. edit_file 空 edits
const { isError: eC1 } = await callRaw('edit_file', { path: path.join(TEST_DIR, 'alpha.txt'), edits: [] })
report('C01 edit_file edits=[]', {}, !eC1 ? 'WARN' : 'PASS', !eC1 ? '空 edits 无报错但执行了无意义文件读写' : '')

// D. search_files 空 pattern
const { text: tD1, isError: eD1 } = await callRaw('search_files', { path: TEST_DIR, pattern: '' })
report('D01 search_files pattern=""', {}, !eD1 ? 'WARN' : 'PASS', !eD1 ? `静默返回"${tD1.slice(0, 40)}",无错误提示` : '')

// E. write_file 空内容
const emptyFilePath = path.join(TEST_DIR, 'empty-content.txt')
const { isError: eE1 } = await callRaw('write_file', { path: emptyFilePath, content: '' })
const { text: tE2 } = await callRaw('read_text_file', { path: emptyFilePath })
report('E01 write_file content=""', {}, (!eE1 && tE2 === '') ? 'PASS' : 'FAIL')

// F. read_media_file 返回格式
const { result: rF1 } = await callRaw('read_media_file', { path: TEST_FILE_MEDIA })
const hasImageContent = (rF1?.content || []).some(c => c.type === 'image')
report('F01 read_media_file PNG返回image类型', {}, hasImageContent ? 'PASS' : 'FAIL', !hasImageContent ? '返回格式异常' : '')

// G. 路径穿越 ../../
const { isError: eG1 } = await callRaw('read_text_file', { path: path.join(TEST_DIR, '..', '..', '..', 'Windows') })
report('G01 路径穿越 ../../', {}, eG1 ? 'PASS' : 'FAIL', !eG1 ? '路径穿越未被阻止!' : '')

// H. 并发 read_multiple_files(测试无限制并发)
const manyPaths = Array.from({ length: 100 }, (_, i) => path.join(TEST_DIR, 'alpha.txt'))
const { isError: eH1 } = await callRaw('read_multiple_files', { paths: manyPaths })
report('H01 read_multiple_files 100个路径并发', {}, !eH1 ? 'PASS' : 'FAIL', '100个并发读取')

// I. move_file 跨设备
const otherDrive = process.platform === 'win32' ? 'D:\\temp' : '/tmp'
try { fs.mkdirSync(path.join(TEST_DIR, 'cross-device-src'), { recursive: true }) } catch {}
const { isError: eI1, text: tI1 } = await callRaw('move_file', { source: path.join(TEST_DIR, 'sub'), destination: path.join(otherDrive, 'fs-mcp-test-mvdest-' + Date.now()) })
report('I01 move_file 跨设备', {}, eI1 ? 'WARN' : 'PASS', eI1 ? `跨设备移动失败: ${tI1.slice(0, 80)}` : '跨设备移动成功')

console.log(`\n成品报告:`)

console.log(`\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
console.log(`  通过: ${passed}  |  失败: ${failed}`)
if (warnings.length > 0) {
  console.log(`  需要关注的警告:`)
  warnings.forEach(w => console.log(`    ⚠️  ${w}`))
}
console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)

// 清理
await client.close()
try { fs.rmSync(TEST_DIR, { recursive: true, force: true }) } catch {}

process.exit(failed > 0 ? 1 : 0)
