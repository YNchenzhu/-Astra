/**
 * Built-in hook presets for the Settings → Hooks panel.
 *
 * Extracted from `useSettingsStore.ts`. These are pure data (no runtime state
 * dependency) and account for ~200 lines of the old store file. The main
 * store re-exports `BUILTIN_HOOKS` and `BuiltInHookPreset` for existing
 * consumers — no import-path changes required downstream.
 */

export interface BuiltInHookPreset {
  id: string
  name: string
  description: string
  icon: string
  event: string
  matcher?: string
  command: string
  async?: boolean
  asyncRewake?: boolean
}

export const BUILTIN_HOOKS: BuiltInHookPreset[] = [
  {
    id: 'dangerous-cmd-guard',
    name: '危险命令防护',
    description: '自动拦截 rm -rf /、format C:、git push --force 等高危命令',
    icon: '🛡️',
    event: 'PreToolUse',
    matcher: 'Bash|bash',
    command: `node -e "const i=JSON.parse(process.env.CLAUDE_TOOL_INPUT||'{}');const cmd=(i.command||'').toLowerCase();const patterns=[/rm\\s+-r[f]?\\s+\\//,/format\\s+[a-z]:/i,/del\\s+\\/[sq]/i,/rd\\s+\\/[sq]/i,/git\\s+push.*--force/,/drop\\s+(database|table)/i,/truncate\\s+table/i,/mkfs\\./,/dd\\s+if=/,/>(\\s*)\\/dev\\/sd/];if(patterns.some(r=>r.test(cmd))){console.log(JSON.stringify({continue:false,reason:'[危险命令防护] 检测到高危命令，已阻止: '+cmd.slice(0,100)}));process.exit(2)}"`,
  },
  {
    id: 'secret-leak-guard',
    name: '敏感信息防泄漏',
    description: '写入文件前检查是否包含 API Key、密码、Token 等敏感信息',
    icon: '🔒',
    event: 'PreToolUse',
    matcher: 'Write|write_file|Edit|edit_file',
    command: `node -e "const i=JSON.parse(process.env.CLAUDE_TOOL_INPUT||'{}');const c=String(i.content||i.file_text||i.newString||i.new_string||'');const checks=[[/(?:sk-|sk-ant-)[a-zA-Z0-9]{20,}/,'Anthropic API Key'],[/AKIA[0-9A-Z]{16}/,'AWS Access Key'],[/(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}/,'GitHub Token'],[/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/,'私钥文件']];for(const[re,name]of checks){if(re.test(c)){console.log(JSON.stringify({continue:false,reason:'[敏感信息防泄漏] 检测到可能的'+name+'，已阻止写入'}));process.exit(2)}}"`,
  },
  {
    id: 'large-file-guard',
    name: '大文件写入保护',
    description: '阻止写入超过 50000 字符的大文件，防止意外覆盖',
    icon: '📏',
    event: 'PreToolUse',
    matcher: 'Write|write_file|Edit|edit_file',
    command: `node -e "const i=JSON.parse(process.env.CLAUDE_TOOL_INPUT||'{}');const c=String(i.content||i.file_text||i.newString||i.new_string||'');const limit=50000;if(c.length>limit){console.log(JSON.stringify({continue:false,reason:'[大文件保护] 内容长度 '+c.length+' 字符，超过上限 '+limit+' 字符'}));process.exit(2)}"`,
  },
  {
    id: 'auto-git-stage',
    name: '自动 Git 暂存',
    description: '文件写入后自动执行 git add，省去手动暂存的步骤',
    icon: '📦',
    event: 'PostToolUse',
    matcher: 'Write|write_file|Edit|edit_file',
    async: true,
    command: 'node -e "const{execSync}=require(\'child_process\');const i=JSON.parse(process.env.CLAUDE_TOOL_INPUT||\'{}\');const f=i.file_path||i.path||i.filePath||\'\';if(f){try{execSync(\'git add \'+JSON.stringify(f),{cwd:process.env.CLAUDE_CWD||\'.\',stdio:\'ignore\'})}catch{}}"',
  },
  {
    id: 'cmd-audit-log',
    name: '命令执行审计',
    description: '记录所有执行的 Shell 命令到日志文件，便于事后追溯',
    icon: '📋',
    event: 'PostToolUse',
    matcher: 'Bash|bash',
    async: true,
    command: `node -e "const fs=require('fs'),p=require('path');const i=JSON.parse(process.env.CLAUDE_TOOL_INPUT||'{}');const cwd=process.env.CLAUDE_CWD||'.';const log=p.join(cwd,'.hook-audit.log');const cmd=(i.command||'').slice(0,500);const line='['+new Date().toISOString()+'] '+cmd+'\\n';try{fs.appendFileSync(log,line)}catch{}"`,
  },
  {
    id: 'auto-backup',
    name: '文件自动备份',
    description: '覆盖文件前自动创建 .bak 备份副本，支持一键恢复',
    icon: '💾',
    event: 'PreToolUse',
    matcher: 'Write|write_file|Edit|edit_file',
    command: `node -e "const fs=require('fs'),p=require('path');const i=JSON.parse(process.env.CLAUDE_TOOL_INPUT||'{}');const raw=i.file_path||i.path||i.filePath||'';const f=raw?p.resolve(process.env.CLAUDE_CWD||'.',raw):'';if(f){try{if(fs.existsSync(f)){fs.copyFileSync(f,f+'.bak')}}catch{}}"`,
  },
  {
    id: 'tool-param-guard',
    name: '工具参数纠错',
    description: '自动检查并修正 AI 工具参数：路径格式纠正、系统命令自动转换，无法修正时拦截',
    icon: '🔧',
    event: 'PreToolUse',
    command: [
      'node -e "',
      "var n=process.env.CLAUDE_TOOL_NAME||'';",
      "var i=JSON.parse(process.env.CLAUDE_TOOL_INPUT||'{}');",
      "var w=process.platform==='win32';",
      "var err=[],fix={},fc=false,bs=String.fromCharCode(92);",
      "function xp(p){if(!p)return null;if(w&&p.length>=3&&p[0]==='/'&&/[a-zA-Z]/.test(p[1])&&p[2]==='/'){return p[1].toUpperCase()+':'+bs+p.slice(3).split('/').join(bs)}return null}",
      "function tp(){return String(i.file_path||i.path||i.filePath||'').trim()}",
      "function spf(r){if(i.filePath!=null&&String(i.filePath).trim()){fix.filePath=r;fc=true}else if(i.file_path!=null&&String(i.file_path).trim()){fix.file_path=r;fc=true}else if(i.path!=null&&String(i.path).trim()){fix.path=r;fc=true}}",
      "if(/^(Write|write|write_file)$/.test(n)){",
        "var pw=tp();",
        "var cw=typeof i.content==='string'?i.content:(typeof i.file_text==='string'?i.file_text:(typeof i.content==='number'?String(i.content):''));",
        "if(!pw)err.push('文件路径为空');",
        "if(!String(cw).trim())err.push('全文件写入内容为空');",
        "var rxw=xp(pw);if(rxw)spf(rxw)}",
      "if(/^(Edit|edit|edit_file|StrReplace)$/.test(n)){",
        "var pe=tp();if(!pe)err.push('文件路径为空');var rxe=xp(pe);if(rxe)spf(rxe)}",
      "if(/^(Read|read|read_file)$/.test(n)){",
        "var pr=tp();if(!pr)err.push('读取路径为空');var rxr=xp(pr);if(rxr)spf(rxr)}",
      "if(/^(Bash|bash|Shell|shell)$/.test(n)){",
        "var cmd=i.command||'';",
        "if(!cmd.trim()){err.push('命令为空')}else{",
          "var sp=cmd.trim().indexOf(' '),f=sp>0?cmd.trim().slice(0,sp).toLowerCase():cmd.trim().toLowerCase();",
          "var m=w?{ls:'dir',cat:'type',rm:'del',cp:'copy',mv:'move',grep:'findstr',clear:'cls',pwd:'cd',touch:'New-Item'}:{dir:'ls',type:'cat',del:'rm',copy:'cp',move:'mv',cls:'clear',findstr:'grep'};",
          "if(m[f]){fix.command=m[f]+cmd.trim().slice(f.length);fc=true}}}",
      "if(err.length){console.log(JSON.stringify({continue:false,reason:'[参数纠错] '+err.join('; ')}));process.exit(2)}",
      "else if(fc){var u=Object.assign({},i,fix);var d=Object.keys(fix).map(function(k){return k+' -> '+fix[k]}).join(', ');",
      "console.log(JSON.stringify({updatedInput:u,systemMessage:'[参数纠错] 已自动修正: '+d}))}",
      '"',
    ].join(''),
  },
]
