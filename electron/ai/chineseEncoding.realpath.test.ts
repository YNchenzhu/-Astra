/**
 * 真实中文/全角标点处理正确率测试（write / edit / 终端）。
 *
 * 测试目标路径含中文 + 全角引号 U+201C/U+201D。默认放在当前仓库的
 * `node_modules/.astra-test-workspaces/` 下，也可用环境变量覆盖为真实项目路径。
 *
 * 这是一个“真实测试”，不是 mock：
 *   - write  → 直接调用真实的 `toolWriteFile`
 *   - edit   → 直接调用真实的 `toolEditFile`（先 `toolReadFile` 拿读回执）
 *   - 终端   → 直接调用真实的 `runPowerShellCommand`（终端工具的 PowerShell 后端，
 *             走 -EncodedCommand UTF-16LE + 会话内强制 UTF-8 + stdout utf-8 解码）
 *
 * 每个用例做“写入 → 读回 → 逐字节/逐字符对比”的往返校验；统计各类与总体正确率，
 * 并通过 console.table 打印一张报告表。
 *
 * 注意：用例固定在目标路径下的 `__zh_encoding_test__/` 子目录，afterAll 仅清理
 * 该子目录，不动用户命名的项目目录。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { toolWriteFile, toolEditFile, toolReadFile } from './tools'
import { runPowerShellCommand } from '../tools/shellRunner'
import { setWorkspacePath } from '../tools/workspaceState'
import { clearAllReadFileState, findCurrentReadIdForPath } from '../tools/readFileState'

// 全角引号 “ ” = U+201C / U+201D，是合法 Windows 文件名字符。环境变量保留了
// 针对指定真实项目路径做人工回归的能力，同时默认路径让 CI/code-dev 门禁可移植。
const TARGET_DIR =
  process.env.ASTRA_ZH_ENCODING_REALPATH_TARGET?.trim() ||
  path.join(
    process.cwd(),
    'node_modules',
    '.astra-test-workspaces',
    '云南开放大学“村干部双提升”智慧展厅及演播室升级改造',
  )
const SANDBOX = path.join(TARGET_DIR, '__zh_encoding_test__')

const isWin = process.platform === 'win32'

// ── 棘手中文/标点样本 ──
const SAMPLES: Record<string, string> = {
  纯中文: '云南开放大学村干部双提升智慧展厅',
  全角标点: '项目名称：“村干部双提升”（演播室升级改造）；预算￥1,200,000。完成了吗？是！',
  中英混排: '展厅 Exhibition Hall 2026 — 升级改造 v2.0（含 AV 系统）',
  破折号em_dash: '一期——二期——三期', // U+2014，AGENTS.md 提到的 GBK 易冲突字符
  生僻字_surrogate: '𠮷野家の𩸽と𠀋', // U+20BB7 等代理对（CJK 扩展 B）
  emoji: '验收通过 ✅ 演播室 🎬 灯光 💡 音响 🔊',
  多行CRLF: '第一行：村干部\r\n第二行：双提升\r\n第三行：智慧展厅\r\n',
  竖排标点: '【一】、（二）、〔三〕、《四》、「五」、『六』',
}

type CaseResult = { 分类: string; 用例: string; 通过: boolean; 详情: string }
const results: CaseResult[] = []
function record(分类: string, 用例: string, 通过: boolean, 详情 = ''): void {
  results.push({ 分类, 用例, 通过, 详情 })
}

beforeAll(() => {
  clearAllReadFileState()
  fs.mkdirSync(SANDBOX, { recursive: true })
  setWorkspacePath(SANDBOX)
})

afterAll(() => {
  setWorkspacePath(null)
  clearAllReadFileState()
  try {
    fs.rmSync(SANDBOX, { recursive: true, force: true })
  } catch {
    /* 保留产物供人工检查也无妨 */
  }
  // 打印正确率报告
  const byCat = new Map<string, { pass: number; total: number }>()
  for (const r of results) {
    const c = byCat.get(r.分类) ?? { pass: 0, total: 0 }
    c.total++
    if (r.通过) c.pass++
    byCat.set(r.分类, c)
  }
  const report: Array<Record<string, string | number>> = []
  for (const [分类, c] of byCat) {
    report.push({ 分类, 通过: c.pass, 总数: c.total, 正确率: `${((c.pass / c.total) * 100).toFixed(1)}%` })
  }
  const totalPass = results.filter((r) => r.通过).length
  report.push({
    分类: '【总体】',
    通过: totalPass,
    总数: results.length,
    正确率: `${((totalPass / results.length) * 100).toFixed(1)}%`,
  })
  // eslint-disable-next-line no-console
  console.log('\n===== 中文/全角标点处理正确率报告（真实路径） =====')
  // eslint-disable-next-line no-console
  console.log('目标路径:', TARGET_DIR)
  // eslint-disable-next-line no-console
  console.table(report)
  const failed = results.filter((r) => !r.通过)
  if (failed.length) {
    // eslint-disable-next-line no-console
    console.log('未通过用例:')
    // eslint-disable-next-line no-console
    console.table(failed)
  }
})

describe('真实中文路径 — write/edit/终端 编码正确率', () => {
  it('分类1 — 中文+全角引号【路径】可创建并往返读写', async () => {
    // 直接在含全角引号的中文祖先路径下写文件，验证路径层 UTF-8 处理。
    for (const [name, content] of Object.entries(SAMPLES)) {
      const fp = path.join(SANDBOX, `路径测试_${name}.txt`)
      const w = await toolWriteFile(fp, content)
      const back = fs.existsSync(fp) ? fs.readFileSync(fp, 'utf-8') : '<缺失>'
      const ok = w.success === true && back === content
      record('中文路径', name, ok, ok ? '' : `write.success=${w.success} back==content=${back === content}`)
      expect(ok, `路径用例 ${name} 失败`).toBe(true)
    }
  })

  it('分类2 — write 工具对中文内容逐字节往返一致', async () => {
    for (const [name, content] of Object.entries(SAMPLES)) {
      const fp = path.join(SANDBOX, `write_${name}.txt`)
      const w = await toolWriteFile(fp, content)
      // 同时用 toolReadFile（工具读）与 fs（裸读）双重校验
      const diskBuf = fs.existsSync(fp) ? fs.readFileSync(fp) : Buffer.alloc(0)
      const diskStr = diskBuf.toString('utf-8')
      const expectBuf = Buffer.from(content, 'utf-8')
      const byteEqual = diskBuf.equals(expectBuf)
      const strEqual = diskStr === content
      const ok = w.success === true && byteEqual && strEqual
      record('write工具', name, ok, ok ? '' : `byteEqual=${byteEqual} strEqual=${strEqual}`)
      expect(ok, `write 用例 ${name} 失败`).toBe(true)
    }
  })

  it('分类3 — edit 工具对中文 old→new 替换正确', async () => {
    const editCases: Array<{ name: string; init: string; oldS: string; newS: string; expect: string; replaceAll?: boolean }> = [
      { name: '中文替换中文', init: '村干部双提升计划', oldS: '双提升', newS: '能力提升', expect: '村干部能力提升计划' },
      { name: '替换为全角标点', init: '项目: 展厅改造', oldS: '项目: 展厅改造', newS: '项目：“展厅改造”（一期）', expect: '项目：“展厅改造”（一期）' },
      { name: 'em破折号替换', init: '一期-二期', oldS: '一期-二期', newS: '一期——二期', expect: '一期——二期' },
      { name: '代理对替换', init: '占位XYZ结束', oldS: 'XYZ', newS: '𠮷野𩸽', expect: '占位𠮷野𩸽结束' },
      { name: 'emoji替换', init: '验收[状态]', oldS: '[状态]', newS: '✅通过🎬', expect: '验收✅通过🎬' },
      { name: 'replaceAll中文', init: '提升A提升B提升C', oldS: '提升', newS: '强化', expect: '强化A强化B强化C', replaceAll: true },
    ]
    for (const c of editCases) {
      const fp = path.join(SANDBOX, `edit_${c.name}.txt`)
      // 用 fs 直写初始内容，再 read 建回执，再走真实 edit 工具
      fs.writeFileSync(fp, c.init, 'utf-8')
      await toolReadFile(fp)
      const baseReadId = findCurrentReadIdForPath(fp)
      const e = await toolEditFile(fp, c.oldS, c.newS, { baseReadId, replaceAll: c.replaceAll })
      const back = fs.existsSync(fp) ? fs.readFileSync(fp, 'utf-8') : '<缺失>'
      const ok = e.success === true && back === c.expect
      record('edit工具', c.name, ok, ok ? '' : `edit.success=${e.success} got=${JSON.stringify(back)}`)
      expect(ok, `edit 用例 ${c.name} 失败: ${e.success ? '' : e.error}`).toBe(true)
    }
  })

  it.skipIf(!isWin)('分类4 — 终端(PowerShell)对中文 输出/路径/文件 往返正确', async () => {
    // 4.1 直接 echo 中文 → 捕获输出包含原文（无 mojibake）
    {
      const s = SAMPLES.全角标点
      const r = await runPowerShellCommand(`Write-Output '${s.replace(/'/g, "''")}'`, SANDBOX)
      const ok = r.success === true && typeof r.output === 'string' && r.output.includes(s)
      record('终端PowerShell', 'echo中文', ok, ok ? '' : `out=${JSON.stringify(r.output)?.slice(0, 120)}`)
      expect(ok, 'PowerShell echo 中文失败').toBe(true)
    }
    // 4.2 PowerShell 写中文文件(UTF8) → Node 裸读应一致
    {
      const s = SAMPLES.纯中文 + SAMPLES.emoji
      const fp = path.join(SANDBOX, 'ps_write.txt')
      const psPath = fp.replace(/'/g, "''")
      const r = await runPowerShellCommand(
        `Set-Content -LiteralPath '${psPath}' -Value '${s.replace(/'/g, "''")}' -Encoding utf8 -NoNewline`,
        SANDBOX,
      )
      const back = fs.existsSync(fp) ? fs.readFileSync(fp, 'utf-8').replace(/^\uFEFF/, '') : '<缺失>'
      const ok = r.success === true && back === s
      record('终端PowerShell', 'PS写文件→Node读', ok, ok ? '' : `got=${JSON.stringify(back)}`)
      expect(ok, 'PowerShell 写中文文件失败').toBe(true)
    }
    // 4.3 Node 写中文文件 → PowerShell Get-Content 输出应包含原文
    {
      const s = SAMPLES.中英混排
      const fp = path.join(SANDBOX, 'node_write.txt')
      fs.writeFileSync(fp, s, 'utf-8')
      const psPath = fp.replace(/'/g, "''")
      const r = await runPowerShellCommand(`Get-Content -LiteralPath '${psPath}' -Encoding utf8 -Raw`, SANDBOX)
      const ok = r.success === true && typeof r.output === 'string' && r.output.includes(s)
      record('终端PowerShell', 'Node写→PS读', ok, ok ? '' : `out=${JSON.stringify(r.output)?.slice(0, 120)}`)
      expect(ok, 'PowerShell 读中文文件失败').toBe(true)
    }
    // 4.4 中文+全角引号【路径】在终端可枚举（Get-ChildItem 列出沙箱所在的中文目录）
    {
      const psPath = SANDBOX.replace(/'/g, "''")
      const r = await runPowerShellCommand(`Get-ChildItem -LiteralPath '${psPath}' -Name`, SANDBOX)
      const ok = r.success === true && typeof r.output === 'string' && r.output.includes('node_write.txt')
      record('终端PowerShell', '中文路径枚举', ok, ok ? '' : `out=${JSON.stringify(r.output)?.slice(0, 120)}`)
      expect(ok, 'PowerShell 枚举中文路径失败').toBe(true)
    }
  })
})
