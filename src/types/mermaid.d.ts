declare module 'mermaid' {
  interface MermaidConfig {
    startOnLoad?: boolean
    theme?: string
    securityLevel?: string
    fontFamily?: string
    themeVariables?: Record<string, string>
  }
  // The previous form declared module-level `function initialize/parse/render`
  // and then `export default mermaid` against an undeclared identifier.  The
  // call sites use `mermaid.initialize(...)` / `mermaid.render(...)` which
  // means the default export must itself be the namespace object, not three
  // free-floating functions.  Modeling it as a typed const avoids three
  // dangling `function` declarations (each flagged as `no-unused-vars`) and
  // matches the runtime shape of the actual `mermaid` package.
  const mermaid: {
    initialize(config: MermaidConfig): void
    parse(text: string, opts?: { suppressErrors?: boolean }): Promise<boolean>
    render(id: string, text: string): Promise<{ svg: string }>
  }
  export default mermaid
}
