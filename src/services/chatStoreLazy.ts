/**
 * 惰性桥接 `useChatStore` 的若干"写入类" API，专供 shell 组件（FileTree、
 * 命令面板等）在用户事件中调用。
 *
 * 为什么要这层壳子：
 *   `useChatStore` 本体 29KB，还静态依赖 chat/sessionSlice、mainStreamRouter、
 *   conversationPersistence、turnQueue 等一整条消息流处理链路。只要 shell
 *   里的任一组件 `import` 它，Vite 在 dev 模式就必须在首屏把整条链路顺序
 *   fetch + transform 完毕，导致应用开场 3-4s 全白。而这些 API 只在用户
 *   真实操作（删除文件、重命名、引用文件到 chat…）时才需要，延迟一次动态
 *   import 的代价可以忽略。
 *
 * 调用点保持 sync 手感 —— 内部 fire-and-forget 做 dynamic import。chunk 第
 * 一次加载后 Vite / 浏览器会缓存，后续调用立即命中。
 */

type ChatStoreModule = typeof import('../stores/useChatStore')

let cached: ChatStoreModule | null = null
let pending: Promise<ChatStoreModule> | null = null

function load(): Promise<ChatStoreModule> {
  if (cached) return Promise.resolve(cached)
  if (!pending) {
    pending = import('../stores/useChatStore').then((m) => {
      cached = m
      return m
    })
  }
  return pending
}

export function syncReferencedAfterDelete(path: string, isFolder: boolean): void {
  void load().then((m) => m.useChatStore.getState().syncReferencedAfterDelete(path, isFolder))
}

export function syncReferencedAfterRename(oldPath: string, newPath: string, isFolder: boolean): void {
  void load().then((m) =>
    m.useChatStore.getState().syncReferencedAfterRename(oldPath, newPath, isFolder),
  )
}

export function toggleReferencedFile(path: string): void {
  void load().then((m) => m.useChatStore.getState().toggleReferencedFile(path))
}
