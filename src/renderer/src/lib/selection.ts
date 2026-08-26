import type { CaptureRect, Point } from '../../../shared/types'

export type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

export function rectFromPoints(start: Point, end: Point): CaptureRect {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y)
  }
}

export function clampRect(rect: CaptureRect, width: number, height: number): CaptureRect {
  const safeWidth = Math.max(1, Math.min(width, Math.round(rect.width)))
  const safeHeight = Math.max(1, Math.min(height, Math.round(rect.height)))

  return {
    x: Math.round(Math.max(0, Math.min(width - safeWidth, rect.x))),
    y: Math.round(Math.max(0, Math.min(height - safeHeight, rect.y))),
    width: safeWidth,
    height: safeHeight
  }
}

export function moveRect(
  rect: CaptureRect,
  delta: Point,
  width: number,
  height: number
): CaptureRect {
  return clampRect({ ...rect, x: rect.x + delta.x, y: rect.y + delta.y }, width, height)
}

function handleEdges(rect: CaptureRect, handle: ResizeHandle, point: Point): CaptureRect {
  let left = rect.x
  let top = rect.y
  let right = rect.x + rect.width
  let bottom = rect.y + rect.height

  if (handle.includes('w')) left = point.x
  if (handle.includes('e')) right = point.x
  if (handle.includes('n')) top = point.y
  if (handle.includes('s')) bottom = point.y

  return rectFromPoints({ x: left, y: top }, { x: right, y: bottom })
}

export function resizeRect(
  rect: CaptureRect,
  handle: ResizeHandle,
  point: Point,
  width: number,
  height: number,
  lockedRatio?: number
): CaptureRect {
  let next = handleEdges(rect, handle, point)

  if (lockedRatio && Number.isFinite(lockedRatio) && lockedRatio > 0) {
    const horizontal = handle === 'e' || handle === 'w'
    const vertical = handle === 'n' || handle === 's'
    const anchorRight = handle.includes('w') ? rect.x + rect.width : rect.x
    const anchorBottom = handle.includes('n') ? rect.y + rect.height : rect.y

    if (vertical) next.width = next.height * lockedRatio
    else next.height = next.width / lockedRatio

    if (!horizontal && !vertical) {
      const heightFromWidth = next.width / lockedRatio
      if (heightFromWidth > next.height) next.height = heightFromWidth
      else next.width = next.height * lockedRatio
    }

    if (handle.includes('w')) next.x = anchorRight - next.width
    if (handle.includes('n')) next.y = anchorBottom - next.height
  }

  return clampRect(next, width, height)
}
