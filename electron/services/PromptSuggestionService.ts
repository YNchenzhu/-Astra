import fs from 'node:fs'
import path from 'node:path'

export interface PromptSuggestion {
  id: string
  text: string
  reason: string
}

interface WorkspaceStructure {
  dirs: string[]
  files: string[]
  hasFile: (name: string) => boolean
  hasDir: (name: string) => boolean
  techStack: string[]
  packageInfo: { name?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | null
}

function scanWorkspace(workspacePath: string): WorkspaceStructure {
  const dirs: string[] = []
  const files: string[] = []

  try {
    const entries = fs.readdirSync(workspacePath, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) dirs.push(entry.name)
      else if (entry.isFile()) files.push(entry.name)
    }
  } catch {
    return { dirs, files, hasFile: () => false, hasDir: () => false, techStack: [], packageInfo: null }
  }

  const hasFile = (name: string) => files.includes(name)
  const hasDir = (name: string) => dirs.includes(name)

  // Detect tech stack from config files
  const techStack: string[] = []
  let packageInfo: WorkspaceStructure['packageInfo'] = null

  if (hasFile('package.json')) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(workspacePath, 'package.json'), 'utf-8'))
      packageInfo = pkg
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }
      const depKeys = Object.keys(allDeps).join(' ').toLowerCase()

      if (depKeys.includes('react') || depKeys.includes('next')) techStack.push('React/Next.js')
      if (depKeys.includes('vue')) techStack.push('Vue')
      if (depKeys.includes('typescript') || hasFile('tsconfig.json')) techStack.push('TypeScript')
      if (depKeys.includes('tailwind')) techStack.push('TailwindCSS')
      if (depKeys.includes('prisma')) techStack.push('Prisma')
      if (depKeys.includes('express') || depKeys.includes('fastify') || depKeys.includes('koa') || depKeys.includes('hono')) techStack.push('Node.js Backend')
    } catch {
      // ignore
    }
  }

  if (hasFile('go.mod')) techStack.push('Go')
  if (hasFile('Cargo.toml')) techStack.push('Rust')
  if (hasFile('requirements.txt') || hasFile('pyproject.toml')) techStack.push('Python')
  if (hasFile('Gemfile')) techStack.push('Ruby')
  if (hasFile('pom.xml') || hasFile('build.gradle') || hasFile('build.gradle.kts')) techStack.push('Java/Kotlin')
  if (hasFile('CMakeLists.txt')) techStack.push('C/C++')
  if (hasDir('.next') || hasDir('dist') || hasDir('build')) techStack.push('Has build output')
  if (hasFile('Dockerfile') || hasFile('docker-compose.yml')) techStack.push('Docker')
  if (hasDir('.github')) techStack.push('GitHub CI/CD')
  if (hasDir('electron')) techStack.push('Electron')

  return { dirs, files, hasFile, hasDir, techStack, packageInfo }
}

// Intent detection patterns (keyword + category name + suggestion)
interface IntentPattern {
  keywords: RegExp
  suggestion: { text: string; reason: string }
}

const INTENT_PATTERNS: IntentPattern[] = [
  {
    keywords: /bug|error|crash|异常|报错|失败|不工作|not working|broken|fail|exception/,
    suggestion: {
      text: '先复现问题，再定位根因，最后给出最小修复并验证。',
      reason: '检测到调试类需求',
    },
  },
  {
    keywords: /refactor|重构|优化|性能|slow|latency|bottleneck|cleanup|技术债|tech debt/,
    suggestion: {
      text: '请先做性能瓶颈分析，再给出低风险优化方案和收益评估。',
      reason: '检测到性能/重构需求',
    },
  },
  {
    keywords: /test|测试|覆盖率|case|unit test|integration|e2e|mock|assert/,
    suggestion: {
      text: '按单元/集成维度补测试，覆盖主路径、边界条件和错误路径。',
      reason: '检测到测试需求',
    },
  },
  {
    keywords: /doc|文档|readme|说明|api doc|swagger|openapi|注释|comment/,
    suggestion: {
      text: '基于目录结构和核心流程更新文档，写清模块职责与边界。',
      reason: '检测到文档需求',
    },
  },
  {
    keywords: /feature|功能|新增|add.*endpoint|add.*api|新.*页面|new.*page|implement|实现/,
    suggestion: {
      text: '先分析现有架构和模式，再设计新功能的接入点，保持风格一致。',
      reason: '检测到新功能开发需求',
    },
  },
  {
    keywords: /security|安全|漏洞|vulnerability|xss|csrf|sql注入|auth|权限|permission/,
    suggestion: {
      text: '检查输入验证、权限控制、敏感数据保护，避免常见 OWASP 漏洞。',
      reason: '检测到安全相关需求',
    },
  },
  {
    keywords: /migrate|迁移|upgrade|升级|版本|version|deprecate|deprecated/,
    suggestion: {
      text: '先评估兼容性和影响范围，制定渐进式迁移方案，确保向后兼容。',
      reason: '检测到迁移/升级需求',
    },
  },
  {
    keywords: /review|审查|检查|check|audit|质量|quality|最佳实践|best practice/,
    suggestion: {
      text: '从代码质量、安全性、性能、可维护性四个维度逐一审查。',
      reason: '检测到代码审查需求',
    },
  },
]

export function getPromptSuggestions(
  userMessage: string,
  workspacePath?: string,
  maxResults = 5,
): PromptSuggestion[] {
  const text = userMessage.toLowerCase()
  const suggestions: PromptSuggestion[] = []

  // 1. Intent detection from user message
  for (const pattern of INTENT_PATTERNS) {
    if (pattern.keywords.test(text)) {
      suggestions.push({
        id: `intent-${suggestions.length}`,
        text: pattern.suggestion.text,
        reason: pattern.suggestion.reason,
      })
    }
  }

  // 2. Workspace structure analysis
  if (workspacePath) {
    const ws = scanWorkspace(workspacePath)

    // Architecture-specific suggestions
    if (ws.hasDir('electron') && ws.hasDir('src')) {
      suggestions.push({
        id: 'arch-review',
        text: '先检查 electron 主进程与 src 渲染进程的边界，再实施改动。',
        reason: '检测到 Electron 分层结构',
      })
    }

    if (ws.hasDir('docs')) {
      suggestions.push({
        id: 'sync-docs',
        text: '实现后同步更新 docs，避免代码与文档漂移。',
        reason: '项目存在 docs 目录',
      })
    }

    if (ws.hasFile('Dockerfile') || ws.hasFile('docker-compose.yml')) {
      suggestions.push({
        id: 'docker-check',
        text: '确认改动是否需要更新镜像构建或多阶段构建配置。',
        reason: '项目使用 Docker 容器化',
      })
    }

    if (ws.hasDir('.github')) {
      suggestions.push({
        id: 'ci-check',
        text: '检查是否需要更新 CI/CD 工作流配置。',
        reason: '项目使用 GitHub Actions',
      })
    }

    // Tech stack specific suggestions
    if (ws.techStack.includes('React/Next.js')) {
      suggestions.push({
        id: 'react-check',
        text: '注意 React Server Components 与 Client Components 的边界。',
        reason: '项目使用 React/Next.js',
      })
    }

    if (ws.techStack.includes('TypeScript')) {
      suggestions.push({
        id: 'ts-check',
        text: '确保类型定义完整，避免 any 类型泛滥。',
        reason: '项目使用 TypeScript',
      })
    }

    if (ws.techStack.includes('TailwindCSS')) {
      suggestions.push({
        id: 'tailwind-check',
        text: '优先使用 Tailwind 工具类，避免内联样式。',
        reason: '项目使用 TailwindCSS',
      })
    }

    if (ws.techStack.includes('Python')) {
      suggestions.push({
        id: 'python-check',
        text: '确认虚拟环境和依赖版本管理正确。',
        reason: '项目使用 Python',
      })
    }

    if (ws.techStack.includes('Go')) {
      suggestions.push({
        id: 'go-check',
        text: '遵循 Go 项目惯例：错误处理、接口设计、测试命名。',
        reason: '项目使用 Go',
      })
    }
  }

  // Fallback: generic suggestions
  if (suggestions.length === 0) {
    suggestions.push(
      {
        id: 'explore-codebase',
        text: '先扫描相关目录与调用链，再执行最小变更。',
        reason: '通用建议',
      },
      {
        id: 'verify-before-done',
        text: '完成改动后运行构建/测试验证，不要只看静态代码。',
        reason: '通用建议',
      },
    )
  }

  return suggestions.slice(0, Math.max(1, maxResults))
}
