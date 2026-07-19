/** Keeps `position: fixed` menus inside the viewport (estimated box before measure). */
export function clampFixedContextMenuPosition(
  clientX: number,
  clientY: number,
  estWidth: number,
  estHeight: number,
  margin = 8,
): { x: number; y: number } {
  const maxX = Math.max(margin, window.innerWidth - estWidth - margin)
  const maxY = Math.max(margin, window.innerHeight - estHeight - margin)
  return {
    x: Math.min(Math.max(margin, clientX), maxX),
    y: Math.min(Math.max(margin, clientY), maxY),
  }
}
