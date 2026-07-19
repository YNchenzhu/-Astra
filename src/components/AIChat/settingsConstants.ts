import type React from 'react'
import {
  Server, KeyRound, Brain, Shield, Lock, GitBranch, Terminal, Palette,
  Sparkles, Plug, FileText, Database, Zap, Wrench, Gauge, HardDrive, Code2,
  Smartphone, MessageCircle,
} from 'lucide-react'
import type {
  DefaultShell,
  DesktopNotificationMode,
  EffortLevel,
  PermissionMode,
  ProviderId,
  SettingsCategoryId,
  WorkspaceTrustModeSetting,
} from '../../stores/useSettingsStore'
import { MODELS_BY_PROVIDER } from '../../stores/useSettingsStore'

export const CATEGORIES: { id: SettingsCategoryId; label: string; icon: React.FC<{ size?: number }> }[] = [
  { id: 'api', label: 'API 配置', icon: Server },
  { id: 'manual', label: '手动配置', icon: KeyRound },
  { id: 'model', label: '模型与行为', icon: Brain },
  { id: 'permissions', label: '权限', icon: Shield },
  { id: 'sandbox', label: '沙盒', icon: Lock },
  { id: 'hooks', label: '全局钩子', icon: GitBranch },
  { id: 'env', label: '环境变量', icon: Terminal },
  { id: 'appearance', label: '外观', icon: Palette },
  { id: 'context', label: '上下文', icon: Gauge },
  { id: 'buddy', label: '伙伴助手', icon: Sparkles },
  { id: 'skills', label: '技能', icon: Zap },
  { id: 'tools', label: '工具', icon: Wrench },
  { id: 'mcp', label: '扩展服务', icon: Plug },
  { id: 'rules', label: '规则', icon: FileText },
  { id: 'memory', label: '记忆', icon: Database },
  { id: 'embedding', label: '向量模型', icon: Sparkles },
  { id: 'lsp', label: '语言服务器', icon: Code2 },
  { id: 'h5', label: '远程访问 (H5)', icon: Smartphone },
  { id: 'im', label: '微信 / IM', icon: MessageCircle },
  { id: 'storage', label: '存储', icon: HardDrive },
]

export const PROVIDER_PLACEHOLDERS: Record<ProviderId, { key: string; hint: string; link?: string }> = {
  anthropic: { key: 'sk-ant-...', hint: '从 console.anthropic.com 获取 API Key', link: 'https://console.anthropic.com/' },
  openai: { key: 'sk-...', hint: '从 platform.openai.com 获取 API Key', link: 'https://platform.openai.com/api-keys' },
  openai2: { key: 'sk-...', hint: 'OpenAI Responses API 端点密钥' },
  gemini: { key: 'AI...', hint: '从 aistudio.google.com 获取 API Key', link: 'https://aistudio.google.com/apikey' },
  bedrock: { key: 'AWS Access Key（可选）', hint: '通过 AWS 凭证或环境变量配置' },
  vertex: { key: 'Service Account Key（可选）', hint: '通过 gcloud CLI 或服务账号配置' },
  foundry: { key: 'API Key', hint: 'Azure API Management 的 Foundry 端点密钥' },
  compatible: { key: 'API Key', hint: '兼容格式端点的 API 密钥' },
  dashscope: { key: 'sk-...', hint: '从阿里云百炼控制台获取 API Key', link: 'https://bailian.console.aliyun.com/' },
  minimax: { key: 'API Key', hint: '从 MiniMax 开放平台获取', link: 'https://platform.minimaxi.com/' },
  zhipu: {
    key: 'API Key',
    hint: '通用与 GLM 编码套餐均使用控制台 API Key；编码套餐说明见智谱 Claude Code 文档',
    link: 'https://docs.bigmodel.cn/cn/coding-plan/tool/claude',
  },
  kimi: { key: 'Moonshot API Key', hint: '与 Claude Code 中 ANTHROPIC_AUTH_TOKEN 相同', link: 'https://platform.kimi.com/console/api-keys' },
  deepseek: { key: 'sk-...', hint: 'DeepSeek 开放平台 API Key', link: 'https://platform.deepseek.com/' },
}

export const LANGUAGE_OPTIONS = [
  { value: '', label: 'English（默认）' },
  { value: '简体中文', label: '简体中文' },
  { value: '繁體中文', label: '繁體中文' },
  { value: '日本語', label: '日本語' },
  { value: '한국어', label: '한국어' },
]

export const EFFORT_LEVELS: Array<{ value: EffortLevel; label: string; hint: string }> = [
  { value: 'low', label: '低', hint: '最小化输出，快速响应' },
  { value: 'medium', label: '中', hint: '精简执行' },
  { value: 'high', label: '高', hint: '平衡执行与解释' },
  { value: 'max', label: '最大', hint: '最全面的分析和执行' },
]

export const SHELL_OPTIONS: Array<{ value: DefaultShell; label: string }> = [
  { value: 'bash', label: 'Bash' },
  { value: 'powershell', label: 'PowerShell' },
  { value: 'cmd', label: 'CMD' },
  { value: 'zsh', label: 'Zsh' },
]

export const DESKTOP_NOTIFICATION_MODES: Array<{ value: DesktopNotificationMode; label: string; hint: string }> = [
  { value: 'off', label: '关闭', hint: '不发送桌面通知' },
  { value: 'minimized', label: '仅最小化', hint: '仅在窗口最小化时通知' },
  { value: 'background', label: '后台提醒', hint: '窗口失焦或最小化时通知' },
  { value: 'always', label: '总是通知', hint: '无论前后台都通知' },
]

export const PERMISSION_MODES: Array<{ value: PermissionMode; label: string; hint: string }> = [
  { value: 'allow', label: '允许', hint: '自动允许执行' },
  { value: 'ask', label: '询问', hint: '执行前询问' },
  { value: 'deny', label: '拒绝', hint: '禁止执行' },
]

export const WORKSPACE_TRUST_MODES: Array<{ value: WorkspaceTrustModeSetting; label: string; hint: string }> = [
  {
    value: 'legacy',
    label: '兼容（默认）',
    hint: '尚未创建信任列表文件时，视为所有文件夹已信任；首次点「信任此工作区」后仅列表内有效。',
  },
  {
    value: 'strict',
    label: '严格',
    hint: '无信任列表文件或文件夹未列入时一律不信任；需显式信任后才加载工作区 / Skill 的 LSP 与 PATH 内置语言服务。',
  },
]

export function getDefaultModel(providerId: ProviderId): string {
  const models = MODELS_BY_PROVIDER[providerId]
  return models.length > 0 ? models[0].id : ''
}
