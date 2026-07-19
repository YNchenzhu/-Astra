import React from 'react'
import { Cpu, Cloud, Database, FolderSearch, Sparkles, Zap } from 'lucide-react'
import type { Messages } from '../../i18n'

export interface LocalModelEntry {
  id: string
  name: string
  description: string
  dir: string
  source: 'bundled' | 'downloaded'
  installed: boolean
  reason?: string
  sizeBytes?: number
  dimensions?: number
}

export interface DownloadableEntry {
  id: string
  name: string
  description: string
  hfRepo: string
  files: string[]
  approxSizeBytes: number
  dimensions: number
}

export interface DownloadProgress {
  modelId: string
  fileIndex: number
  totalFiles: number
  currentFile: string
  currentBytes: number
  currentTotal: number
  overallBytes: number
  overallTotal: number
  state: 'downloading' | 'done' | 'error'
  error?: string
}

export type SectionId = 'mode' | 'local' | 'cloud' | 'rerank' | 'workspace' | 'cache'

export interface SectionMeta {
  id: SectionId
  label: string
  icon: React.FC<{ size?: number }>
  hint: string
}

export function buildSections(t: Messages['settings']['embedding']): SectionMeta[] {
  return [
    { id: 'mode',      label: t.secModeLabel,      icon: Zap,          hint: t.secModeHint },
    { id: 'local',     label: t.secLocalLabel,     icon: Cpu,          hint: t.secLocalHint },
    { id: 'cloud',     label: t.secCloudLabel,     icon: Cloud,        hint: t.secCloudHint },
    { id: 'rerank',    label: t.secRerankLabel,    icon: Sparkles,     hint: t.secRerankHint },
    { id: 'workspace', label: t.secWorkspaceLabel, icon: FolderSearch, hint: t.secWorkspaceHint },
    { id: 'cache',     label: t.secCacheLabel,     icon: Database,     hint: t.secCacheHint },
  ]
}

export function formatBytes(n: number): string {
  if (!n || n <= 0) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
