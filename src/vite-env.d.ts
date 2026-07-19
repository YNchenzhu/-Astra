/// <reference types="vite/client" />

/** Vite 的 `*?worker` 无法匹配带多段路径的模块名，为 Monaco worker 显式声明 */
type ViteWorkerConstructor = {
  new (options?: { name?: string }): Worker
}

declare module 'monaco-editor/esm/vs/editor/editor.worker?worker' {
  const workerConstructor: ViteWorkerConstructor
  export default workerConstructor
}

declare module 'monaco-editor/esm/vs/language/json/json.worker?worker' {
  const workerConstructor: ViteWorkerConstructor
  export default workerConstructor
}

declare module 'monaco-editor/esm/vs/language/css/css.worker?worker' {
  const workerConstructor: ViteWorkerConstructor
  export default workerConstructor
}

declare module 'monaco-editor/esm/vs/language/html/html.worker?worker' {
  const workerConstructor: ViteWorkerConstructor
  export default workerConstructor
}

declare module 'monaco-editor/esm/vs/language/typescript/ts.worker?worker' {
  const workerConstructor: ViteWorkerConstructor
  export default workerConstructor
}
