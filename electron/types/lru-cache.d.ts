/**
 * Ambient types for `lru-cache`: the dependency may ship without bundled types
 * or as an older major; this matches the options used by {@link FileStateCache}.
 */
declare module 'lru-cache' {
  export default class LRUCache<K = unknown, V = unknown> {
    constructor(options: {
      max?: number
      maxSize?: number
      sizeCalculation?: (value: V, key: K) => number
    })

    get(key: K): V | undefined
    set(key: K, value: V): this
    has(key: K): boolean
    delete(key: K): boolean
    clear(): void

    readonly size: number
    readonly max: number
    readonly maxSize: number
    readonly calculatedSize: number

    keys(): Generator<K>
    entries(): Generator<[K, V]>

    dump(): unknown[]
    load(cacheEntries: unknown[]): void
  }
}
