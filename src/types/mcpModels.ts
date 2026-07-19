export interface MCPDiagnosticCompact {
  serverName: string
  status: string
  error?: string
  suggestion?: string
  transport: string
  toolCount: number
}

export interface MCPPresetCompact {
  id: string
  name: string
  description: string
  config: Record<string, unknown>
  category: string
}

export interface MCPResourceCompact {
  uri: string
  name: string
  description?: string
  mimeType?: string
  server: string
}

export interface MCPResourceContent {
  uri: string
  mimeType?: string
  text?: string
  blobSavedTo?: string
}
