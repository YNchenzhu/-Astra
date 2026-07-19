import type { FileNode, ChatMessage, SearchResult, GitChange } from '../types'

export const fileTree: FileNode[] = [
  {
    name: 'src',
    path: 'src',
    type: 'folder',
    children: [
      {
        name: 'components',
        path: 'src/components',
        type: 'folder',
        children: [
          {
            name: 'App.tsx',
            path: 'src/components/App.tsx',
            type: 'file',
            language: 'typescript',
            content: `import React, { useState, useEffect } from 'react'
import { Header } from './Header'
import { Sidebar } from './Sidebar'
import { MainContent } from './MainContent'
import { useTheme } from '../hooks/useTheme'

interface AppProps {
  initialRoute?: string
}

export const App: React.FC<AppProps> = ({ initialRoute = '/' }) => {
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [currentRoute, setCurrentRoute] = useState(initialRoute)
  const theme = useTheme()

  useEffect(() => {
    document.title = \`My App - \${currentRoute}\`
  }, [currentRoute])

  const handleNavigate = (route: string) => {
    setCurrentRoute(route)
  }

  const toggleSidebar = () => {
    setSidebarOpen(prev => !prev)
  }

  return (
    <div className={\`app-container \${theme}\`}>
      <Header
        onToggleSidebar={toggleSidebar}
        sidebarOpen={sidebarOpen}
      />
      <div className="app-layout">
        {sidebarOpen && (
          <Sidebar
            currentRoute={currentRoute}
            onNavigate={handleNavigate}
          />
        )}
        <MainContent route={currentRoute} />
      </div>
    </div>
  )
}`,
          },
          {
            name: 'Header.tsx',
            path: 'src/components/Header.tsx',
            type: 'file',
            language: 'typescript',
            content: `import React from 'react'

interface HeaderProps {
  onToggleSidebar: () => void
  sidebarOpen: boolean
}

export const Header: React.FC<HeaderProps> = ({
  onToggleSidebar,
  sidebarOpen,
}) => {
  return (
    <header className="header">
      <button
        className="menu-toggle"
        onClick={onToggleSidebar}
        aria-label="Toggle sidebar"
      >
        {sidebarOpen ? '◀' : '▶'}
      </button>
      <h1 className="header-title">Application</h1>
      <nav className="header-nav">
        <a href="/">Home</a>
        <a href="/about">About</a>
        <a href="/settings">Settings</a>
      </nav>
    </header>
  )
}`,
          },
        ],
      },
      {
        name: 'hooks',
        path: 'src/hooks',
        type: 'folder',
        children: [
          {
            name: 'useTheme.ts',
            path: 'src/hooks/useTheme.ts',
            type: 'file',
            language: 'typescript',
            content: `import { useState, useEffect, useCallback } from 'react'

type Theme = 'light' | 'dark' | 'system'

export function useTheme(defaultTheme: Theme = 'system') {
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem('theme')
    return (saved as Theme) || defaultTheme
  })

  const resolvedTheme = theme === 'system'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light'
    : theme

  useEffect(() => {
    localStorage.setItem('theme', theme)
    document.documentElement.setAttribute('data-theme', resolvedTheme)
  }, [theme, resolvedTheme])

  const toggleTheme = useCallback(() => {
    setTheme(prev => prev === 'dark' ? 'light' : 'dark')
  }, [])

  return { theme, resolvedTheme, setTheme, toggleTheme }
}`,
          },
        ],
      },
      {
        name: 'utils',
        path: 'src/utils',
        type: 'folder',
        children: [
          {
            name: 'api.ts',
            path: 'src/utils/api.ts',
            type: 'file',
            language: 'typescript',
            content: `const BASE_URL = 'https://api.example.com/v1'

interface RequestConfig {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  headers?: Record<string, string>
  body?: unknown
}

class ApiClient {
  private baseUrl: string
  private token: string | null = null

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl
  }

  setToken(token: string) {
    this.token = token
  }

  private async request<T>(endpoint: string, config: RequestConfig = {}): Promise<T> {
    const { method = 'GET', headers = {}, body } = config

    const response = await fetch(\`\${this.baseUrl}\${endpoint}\`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(this.token ? { Authorization: \`Bearer \${this.token}\` } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    })

    if (!response.ok) {
      throw new Error(\`API Error: \${response.status} \${response.statusText}\`)
    }

    return response.json()
  }

  async get<T>(endpoint: string) {
    return this.request<T>(endpoint)
  }

  async post<T>(endpoint: string, body: unknown) {
    return this.request<T>(endpoint, { method: 'POST', body })
  }
}

export const api = new ApiClient(BASE_URL)`,
          },
          {
            name: 'helpers.ts',
            path: 'src/utils/helpers.ts',
            type: 'file',
            language: 'typescript',
            content: `export function debounce<T extends (...args: unknown[]) => unknown>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout>
  return (...args: Parameters<T>) => {
    clearTimeout(timeoutId)
    timeoutId = setTimeout(() => fn(...args), delay)
  }
}

export function formatDate(date: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

export function classNames(...classes: (string | boolean | undefined)[]): string {
  return classes.filter(Boolean).join(' ')
}`,
          },
        ],
      },
      {
        name: 'index.ts',
        path: 'src/index.ts',
        type: 'file',
        language: 'typescript',
        content: `import { App } from './components/App'
import { createRoot } from 'react-dom/client'

const root = createRoot(document.getElementById('root')!)
root.render(<App />)`,
      },
    ],
  },
  {
    name: 'package.json',
    path: 'package.json',
    type: 'file',
    language: 'json',
    content: `{
  "name": "my-project",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0"
  }
}`,
  },
  {
    name: 'tsconfig.json',
    path: 'tsconfig.json',
    type: 'file',
    language: 'json',
    content: `{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src"]
}`,
  },
  {
    name: 'README.md',
    path: 'README.md',
    type: 'file',
    language: 'markdown',
    content: `# My Project

A modern web application built with React and TypeScript.

## Getting Started

\`\`\`bash
npm install
npm run dev
\`\`\`

## Project Structure

- \`src/components/\` - React components
- \`src/hooks/\` - Custom React hooks
- \`src/utils/\` - Utility functions

## License

MIT
`,
  },
]

export const mockChatMessages: ChatMessage[] = [
  {
    id: '1',
    role: 'user',
    content: '帮我写一个 React Hook，用于管理表单状态，支持验证和重置功能。',
    timestamp: Date.now() - 300000,
  },
  {
    id: '2',
    role: 'assistant',
    content: '这是一个功能完整的 `useForm` Hook，支持字段验证、重置和动态字段管理：',
    timestamp: Date.now() - 290000,
    codeBlocks: [
      {
        language: 'typescript',
        fileName: 'src/hooks/useForm.ts',
        code: `import { useState, useCallback } from 'react'

interface FieldValidation {
  required?: boolean
  minLength?: number
  maxLength?: number
  pattern?: RegExp
  custom?: (value: string) => string | undefined
}

interface FieldConfig {
  validation?: FieldValidation
  defaultValue?: string
}

type FormErrors = Record<string, string>

export function useForm<T extends Record<string, string>>(
  fields: Record<keyof T, FieldConfig>
) {
  const initialValues = Object.fromEntries(
    Object.entries(fields).map(([key, config]) => [key, config.defaultValue || ''])
  ) as T

  const [values, setValues] = useState<T>(initialValues)
  const [errors, setErrors] = useState<FormErrors>({})
  const [touched, setTouched] = useState<Record<string, boolean>>({})

  const validate = useCallback((): boolean => {
    const newErrors: FormErrors = {}
    let isValid = true

    for (const [key, config] of Object.entries(fields)) {
      const value = values[key as keyof T]
      const validation = config.validation

      if (validation?.required && !value) {
        newErrors[key] = 'This field is required'
        isValid = false
      } else if (validation?.minLength && value.length < validation.minLength) {
        newErrors[key] = \`Minimum \${validation.minLength} characters\`
        isValid = false
      } else if (validation?.custom) {
        const error = validation.custom(value)
        if (error) {
          newErrors[key] = error
          isValid = false
        }
      }
    }

    setErrors(newErrors)
    return isValid
  }, [values, fields])

  const setValue = useCallback((field: keyof T, value: string) => {
    setValues(prev => ({ ...prev, [field]: value }))
    setTouched(prev => ({ ...prev, [field]: true }))
  }, [])

  const reset = useCallback(() => {
    setValues(initialValues)
    setErrors({})
    setTouched({})
  }, [initialValues])

  return { values, errors, touched, setValue, validate, reset }
}`,
      },
    ],
  },
  {
    id: '3',
    role: 'user',
    content: '能不能给这个 Hook 加上异步验证？比如用户名查重。',
    timestamp: Date.now() - 200000,
  },
  {
    id: '4',
    role: 'assistant',
    content: '当然可以。添加 `asyncValidation` 支持和 `isSubmitting` 状态：',
    timestamp: Date.now() - 190000,
    codeBlocks: [
      {
        language: 'typescript',
        fileName: 'src/hooks/useForm.ts',
        code: `// 在 FieldConfig 中添加 asyncValidation
interface FieldConfig {
  validation?: FieldValidation
  asyncValidation?: (value: string) => Promise<string | undefined>
  defaultValue?: string
}

// 在 useForm 中添加
const [asyncErrors, setAsyncErrors] = useState<FormErrors>({})
const [isSubmitting, setIsSubmitting] = useState(false)

const validateField = useCallback(
  async (field: string) => {
    const config = fields[field as keyof T]
    const value = values[field as keyof T]

    if (config?.asyncValidation) {
      const error = await config.asyncValidation(value)
      setAsyncErrors(prev => ({
        ...prev,
        [field]: error || undefined,
      }))
    }
  },
  [values, fields]
)`,
      },
    ],
  },
]

export const mockSearchResults: SearchResult[] = [
  {
    file: 'App.tsx',
    path: 'src/components/App.tsx',
    matches: [
      { line: 15, text: `const [sidebarOpen, setSidebarOpen] = useState(true)` },
      { line: 28, text: `const toggleSidebar = () => {` },
    ],
  },
  {
    file: 'Header.tsx',
    path: 'src/components/Header.tsx',
    matches: [
      { line: 8, text: `sidebarOpen: boolean` },
      { line: 14, text: `const Header: React.FC<HeaderProps> = ({` },
    ],
  },
  {
    file: 'useTheme.ts',
    path: 'src/hooks/useTheme.ts',
    matches: [
      { line: 5, text: `type Theme = 'light' | 'dark' | 'system'` },
    ],
  },
]

export const mockGitChanges: GitChange[] = [
  { file: 'App.tsx', path: 'src/components/App.tsx', status: 'modified' },
  { file: 'Header.tsx', path: 'src/components/Header.tsx', status: 'modified' },
  { file: 'useForm.ts', path: 'src/hooks/useForm.ts', status: 'added' },
  { file: 'api.ts', path: 'src/utils/api.ts', status: 'modified' },
  { file: 'helpers.ts', path: 'src/utils/helpers.ts', status: 'untracked' },
]
