export const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])

export interface ElectronFile extends File {
  readonly path?: string
}
