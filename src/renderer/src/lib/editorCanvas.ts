import type {
  Annotation,
  BoundsAnnotation,
  CaptureRect,
  Point
} from '../../../shared/types'

export interface DrawEditorSceneOptions {
  imageWidth: number
  imageHeight: number
  imageX?: number
  imageY?: number
  draft?: Annotation | null
  selectedId?: string | null
  showCropMask?: boolean
}

const MIN_EXPORT_SIZE = 1

export function loadCanvasImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('截图图像加载失败'))
    image.src = dataUrl
  })
}

export function normalizeBounds(start: Point, end: Point): CaptureRect {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y)
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function insetToCanvas(rect: CaptureRect, width: number, height: number): CaptureRect {
  const left = clamp(rect.x, 0, width)
  const top = clamp(rect.y, 0, height)
  const right = clamp(rect.x + rect.width, 0, width)
  const bottom = clamp(rect.y + rect.height, 0, height)
  return {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top)
  }
}

export function getActiveCrop(
  annotations: Annotation[],
  imageWidth: number,
  imageHeight: number
): CaptureRect | null {
  const crop = [...annotations]
    .reverse()
    .find((annotation): annotation is BoundsAnnotation => annotation.tool === 'crop')
  if (!crop) return null

  const bounds = insetToCanvas(normalizeBounds(crop.start, crop.end), imageWidth, imageHeight)
  if (bounds.width < MIN_EXPORT_SIZE || bounds.height < MIN_EXPORT_SIZE) return null

  const left = Math.floor(bounds.x)
  const top = Math.floor(bounds.y)
  const right = Math.ceil(bounds.x + bounds.width)
  const bottom = Math.ceil(bounds.y + bounds.height)
  return {
    x: left,
    y: top,
    width: Math.max(MIN_EXPORT_SIZE, right - left),
    height: Math.max(MIN_EXPORT_SIZE, bottom - top)
  }
}

function drawRoundedLine(
  context: CanvasRenderingContext2D,
  points: Point[],
  color: string,
  strokeWidth: number,
  alpha = 1
): void {
  if (points.length < 2) return
  context.save()
  context.globalAlpha = alpha
  context.strokeStyle = color
  context.lineWidth = strokeWidth
  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.beginPath()
  context.moveTo(points[0].x, points[0].y)
  for (let index = 1; index < points.length; index += 1) {
    context.lineTo(points[index].x, points[index].y)
  }
  context.stroke()
  context.restore()
}

function drawArrowHead(
  context: CanvasRenderingContext2D,
  start: Point,
  end: Point,
  color: string,
  strokeWidth: number
): void {
  const angle = Math.atan2(end.y - start.y, end.x - start.x)
  const length = Math.max(11, strokeWidth * 4.5)
  context.save()
  context.strokeStyle = color
  context.fillStyle = color
  context.lineWidth = strokeWidth
  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.beginPath()
  context.moveTo(end.x, end.y)
  context.lineTo(
    end.x - length * Math.cos(angle - Math.PI / 6),
    end.y - length * Math.sin(angle - Math.PI / 6)
  )
  context.lineTo(
    end.x - length * Math.cos(angle + Math.PI / 6),
    end.y - length * Math.sin(angle + Math.PI / 6)
  )
  context.closePath()
  context.fill()
  context.restore()
}

function drawTextAnnotation(
  context: CanvasRenderingContext2D,
  point: Point,
  text: string,
  fontSize: number,
  color: string
): void {
  const lines = text.split('\n')
  const lineHeight = fontSize * 1.28
  context.save()
  context.fillStyle = color
  context.textAlign = 'left'
  context.textBaseline = 'top'
  context.font = `600 ${fontSize}px "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif`
  lines.forEach((line, index) => context.fillText(line || ' ', point.x, point.y + lineHeight * index))
  context.restore()
}

function drawNumberAnnotation(
  context: CanvasRenderingContext2D,
  point: Point,
  value: number,
  color: string,
  strokeWidth: number
): void {
  const radius = Math.max(13, strokeWidth * 2 + 10)
  context.save()
  context.fillStyle = color
  context.beginPath()
  context.arc(point.x, point.y, radius, 0, Math.PI * 2)
  context.fill()
  context.fillStyle = '#fffdf8'
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.font = `700 ${Math.max(13, radius * 1.05)}px "Noto Sans SC", "PingFang SC", sans-serif`
  context.fillText(String(value), point.x, point.y + 0.5)
  context.restore()
}

function pixelateRegion(
  context: CanvasRenderingContext2D,
  annotation: BoundsAnnotation
): void {
  const requested = normalizeBounds(annotation.start, annotation.end)
  const bounds = insetToCanvas(requested, context.canvas.width, context.canvas.height)
  if (bounds.width < 1 || bounds.height < 1) return

  const blockSize = Math.max(7, annotation.strokeWidth * 3)
  const sampleWidth = Math.max(1, Math.ceil(bounds.width / blockSize))
  const sampleHeight = Math.max(1, Math.ceil(bounds.height / blockSize))
  const sample = document.createElement('canvas')
  sample.width = sampleWidth
  sample.height = sampleHeight
  const sampleContext = sample.getContext('2d')
  if (!sampleContext) return

  sampleContext.imageSmoothingEnabled = true
  sampleContext.drawImage(
    context.canvas,
    bounds.x,
    bounds.y,
    bounds.width,
    bounds.height,
    0,
    0,
    sampleWidth,
    sampleHeight
  )

  context.save()
  context.imageSmoothingEnabled = false
  context.drawImage(
    sample,
    0,
    0,
    sampleWidth,
    sampleHeight,
    bounds.x,
    bounds.y,
    bounds.width,
    bounds.height
  )
  context.restore()
}

function blurRegion(context: CanvasRenderingContext2D, annotation: BoundsAnnotation): void {
  const requested = normalizeBounds(annotation.start, annotation.end)
  const bounds = insetToCanvas(requested, context.canvas.width, context.canvas.height)
  if (bounds.width < 1 || bounds.height < 1) return

  const radius = Math.max(4, annotation.strokeWidth * 1.8)
  const padding = Math.ceil(radius * 2.5)
  const sampleX = Math.max(0, Math.floor(bounds.x - padding))
  const sampleY = Math.max(0, Math.floor(bounds.y - padding))
  const sampleRight = Math.min(context.canvas.width, Math.ceil(bounds.x + bounds.width + padding))
  const sampleBottom = Math.min(context.canvas.height, Math.ceil(bounds.y + bounds.height + padding))
  const sampleWidth = Math.max(1, sampleRight - sampleX)
  const sampleHeight = Math.max(1, sampleBottom - sampleY)
  const snapshot = document.createElement('canvas')
  snapshot.width = sampleWidth
  snapshot.height = sampleHeight
  const snapshotContext = snapshot.getContext('2d')
  if (!snapshotContext) return
  snapshotContext.drawImage(
    context.canvas,
    sampleX,
    sampleY,
    sampleWidth,
    sampleHeight,
    0,
    0,
    sampleWidth,
    sampleHeight
  )

  context.save()
  context.beginPath()
  context.rect(bounds.x, bounds.y, bounds.width, bounds.height)
  context.clip()
  context.filter = `blur(${radius}px)`
  context.drawImage(snapshot, sampleX, sampleY)
  context.restore()
}

export function drawAnnotation(
  context: CanvasRenderingContext2D,
  annotation: Annotation,
  preview = false
): void {
  const { color, strokeWidth } = annotation

  switch (annotation.tool) {
    case 'rectangle': {
      const bounds = normalizeBounds(annotation.start, annotation.end)
      context.save()
      context.strokeStyle = color
      context.lineWidth = strokeWidth
      context.lineJoin = 'round'
      if (preview) context.setLineDash([Math.max(5, strokeWidth * 2), Math.max(4, strokeWidth * 1.5)])
      context.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height)
      context.restore()
      break
    }
    case 'ellipse': {
      const bounds = normalizeBounds(annotation.start, annotation.end)
      context.save()
      context.strokeStyle = color
      context.lineWidth = strokeWidth
      if (preview) context.setLineDash([Math.max(5, strokeWidth * 2), Math.max(4, strokeWidth * 1.5)])
      context.beginPath()
      context.ellipse(
        bounds.x + bounds.width / 2,
        bounds.y + bounds.height / 2,
        Math.max(0.1, bounds.width / 2),
        Math.max(0.1, bounds.height / 2),
        0,
        0,
        Math.PI * 2
      )
      context.stroke()
      context.restore()
      break
    }
    case 'line':
    case 'arrow': {
      drawRoundedLine(context, [annotation.start, annotation.end], color, strokeWidth)
      if (annotation.tool === 'arrow') {
        drawArrowHead(context, annotation.start, annotation.end, color, strokeWidth)
      }
      break
    }
    case 'pen':
      drawRoundedLine(context, annotation.points, color, strokeWidth)
      break
    case 'highlighter':
      drawRoundedLine(context, annotation.points, color, Math.max(8, strokeWidth * 4), 0.34)
      break
    case 'text':
      drawTextAnnotation(context, annotation.point, annotation.text, annotation.fontSize, color)
      break
    case 'number':
      drawNumberAnnotation(context, annotation.point, annotation.value, color, strokeWidth)
      break
    case 'mosaic': {
      pixelateRegion(context, annotation)
      if (preview) {
        const bounds = normalizeBounds(annotation.start, annotation.end)
        context.save()
        context.strokeStyle = color
        context.lineWidth = Math.max(1, strokeWidth)
        context.setLineDash([6, 5])
        context.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height)
        context.restore()
      }
      break
    }
    case 'blur': {
      blurRegion(context, annotation)
      if (preview) {
        const bounds = normalizeBounds(annotation.start, annotation.end)
        context.save()
        context.strokeStyle = color
        context.lineWidth = Math.max(1, strokeWidth)
        context.setLineDash([6, 5])
        context.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height)
        context.restore()
      }
      break
    }
    case 'crop':
      break
    default:
      break
  }
}

function drawCropMask(
  context: CanvasRenderingContext2D,
  annotation: BoundsAnnotation
): void {
  const bounds = insetToCanvas(
    normalizeBounds(annotation.start, annotation.end),
    context.canvas.width,
    context.canvas.height
  )
  if (bounds.width < 1 || bounds.height < 1) return

  context.save()
  context.fillStyle = 'rgba(18, 22, 30, 0.48)'
  context.beginPath()
  context.rect(0, 0, context.canvas.width, context.canvas.height)
  context.rect(bounds.x, bounds.y, bounds.width, bounds.height)
  context.fill('evenodd')
  context.strokeStyle = '#fffdf8'
  context.lineWidth = 1.5
  context.setLineDash([8, 5])
  context.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height)

  const handleSize = 8
  context.setLineDash([])
  context.fillStyle = '#fffdf8'
  ;[
    [bounds.x, bounds.y],
    [bounds.x + bounds.width, bounds.y],
    [bounds.x, bounds.y + bounds.height],
    [bounds.x + bounds.width, bounds.y + bounds.height]
  ].forEach(([x, y]) => {
    context.fillRect(x - handleSize / 2, y - handleSize / 2, handleSize, handleSize)
  })
  context.restore()
}

export function annotationBounds(annotation: Annotation): CaptureRect {
  switch (annotation.tool) {
    case 'rectangle':
    case 'ellipse':
    case 'mosaic':
    case 'blur':
    case 'crop':
    case 'line':
    case 'arrow':
      return normalizeBounds(annotation.start, annotation.end)
    case 'pen':
    case 'highlighter': {
      if (annotation.points.length === 0) return { x: 0, y: 0, width: 0, height: 0 }
      const xs = annotation.points.map((point) => point.x)
      const ys = annotation.points.map((point) => point.y)
      const left = Math.min(...xs)
      const top = Math.min(...ys)
      return {
        x: left,
        y: top,
        width: Math.max(1, Math.max(...xs) - left),
        height: Math.max(1, Math.max(...ys) - top)
      }
    }
    case 'text': {
      const lines = annotation.text.split('\n')
      const longestLine = Math.max(1, ...lines.map((line) => Array.from(line).length))
      return {
        x: annotation.point.x,
        y: annotation.point.y,
        width: longestLine * annotation.fontSize * 0.68,
        height: Math.max(1, lines.length) * annotation.fontSize * 1.28
      }
    }
    case 'number': {
      const radius = Math.max(13, annotation.strokeWidth * 2 + 10)
      return {
        x: annotation.point.x - radius,
        y: annotation.point.y - radius,
        width: radius * 2,
        height: radius * 2
      }
    }
    default:
      return { x: 0, y: 0, width: 0, height: 0 }
  }
}

function drawSelection(context: CanvasRenderingContext2D, annotation: Annotation): void {
  const bounds = annotationBounds(annotation)
  const padding = Math.max(5, annotation.strokeWidth * 1.5)
  context.save()
  context.strokeStyle = '#356fc2'
  context.lineWidth = 1.5
  context.setLineDash([5, 4])
  context.strokeRect(
    bounds.x - padding,
    bounds.y - padding,
    bounds.width + padding * 2,
    bounds.height + padding * 2
  )
  context.restore()
}

export function drawEditorScene(
  context: CanvasRenderingContext2D,
  image: CanvasImageSource,
  annotations: Annotation[],
  options: DrawEditorSceneOptions
): void {
  const {
    imageWidth,
    imageHeight,
    imageX = 0,
    imageY = 0,
    draft = null,
    selectedId = null,
    showCropMask = true
  } = options

  context.save()
  context.setTransform(1, 0, 0, 1, 0, 0)
  context.clearRect(0, 0, context.canvas.width, context.canvas.height)
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(image, imageX, imageY, imageWidth, imageHeight)
  context.restore()

  annotations.forEach((annotation) => {
    if (annotation.tool !== 'crop') drawAnnotation(context, annotation)
  })

  if (draft && draft.tool !== 'crop') drawAnnotation(context, draft, true)

  const selected = annotations.find((annotation) => annotation.id === selectedId)
  if (selected && selected.tool !== 'crop') drawSelection(context, selected)

  if (showCropMask) {
    const draftCrop = draft?.tool === 'crop' ? draft : null
    const committedCrop = [...annotations]
      .reverse()
      .find((annotation): annotation is BoundsAnnotation => annotation.tool === 'crop')
    const crop = draftCrop ?? committedCrop
    if (crop) drawCropMask(context, crop)
  }
}

function distanceToSegment(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x
  const dy = end.y - start.y
  if (dx === 0 && dy === 0) return Math.hypot(point.x - start.x, point.y - start.y)
  const lengthSquared = dx * dx + dy * dy
  const ratio = clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared, 0, 1)
  const closestX = start.x + ratio * dx
  const closestY = start.y + ratio * dy
  return Math.hypot(point.x - closestX, point.y - closestY)
}

export function hitTestAnnotation(
  annotations: Annotation[],
  point: Point,
  tolerance = 8
): Annotation | null {
  for (let index = annotations.length - 1; index >= 0; index -= 1) {
    const annotation = annotations[index]
    if (annotation.tool === 'line' || annotation.tool === 'arrow') {
      if (distanceToSegment(point, annotation.start, annotation.end) <= tolerance + annotation.strokeWidth) {
        return annotation
      }
      continue
    }

    if (annotation.tool === 'pen' || annotation.tool === 'highlighter') {
      for (let pointIndex = 1; pointIndex < annotation.points.length; pointIndex += 1) {
        if (
          distanceToSegment(point, annotation.points[pointIndex - 1], annotation.points[pointIndex]) <=
          tolerance + annotation.strokeWidth
        ) {
          return annotation
        }
      }
      continue
    }

    const bounds = annotationBounds(annotation)
    if (annotation.tool === 'crop') {
      const withinOuterBounds =
        point.x >= bounds.x - tolerance &&
        point.x <= bounds.x + bounds.width + tolerance &&
        point.y >= bounds.y - tolerance &&
        point.y <= bounds.y + bounds.height + tolerance
      const nearestEdge = Math.min(
        Math.abs(point.x - bounds.x),
        Math.abs(point.x - (bounds.x + bounds.width)),
        Math.abs(point.y - bounds.y),
        Math.abs(point.y - (bounds.y + bounds.height))
      )
      if (withinOuterBounds && nearestEdge <= tolerance * 1.5) return annotation
      continue
    }
    if (
      point.x >= bounds.x - tolerance &&
      point.x <= bounds.x + bounds.width + tolerance &&
      point.y >= bounds.y - tolerance &&
      point.y <= bounds.y + bounds.height + tolerance
    ) {
      return annotation
    }
  }
  return null
}

function movePoint(point: Point, deltaX: number, deltaY: number): Point {
  return { x: point.x + deltaX, y: point.y + deltaY }
}

export function translateAnnotation(
  annotation: Annotation,
  deltaX: number,
  deltaY: number
): Annotation {
  switch (annotation.tool) {
    case 'rectangle':
    case 'ellipse':
    case 'mosaic':
    case 'blur':
    case 'crop':
      return {
        ...annotation,
        start: movePoint(annotation.start, deltaX, deltaY),
        end: movePoint(annotation.end, deltaX, deltaY)
      }
    case 'line':
    case 'arrow':
      return {
        ...annotation,
        start: movePoint(annotation.start, deltaX, deltaY),
        end: movePoint(annotation.end, deltaX, deltaY)
      }
    case 'pen':
    case 'highlighter':
      return {
        ...annotation,
        points: annotation.points.map((point) => movePoint(point, deltaX, deltaY))
      }
    case 'text':
      return { ...annotation, point: movePoint(annotation.point, deltaX, deltaY) }
    case 'number':
      return { ...annotation, point: movePoint(annotation.point, deltaX, deltaY) }
    default:
      return annotation
  }
}

export function exportEditorDataUrl(
  image: CanvasImageSource,
  annotations: Annotation[],
  imageWidth: number,
  imageHeight: number
): string {
  const crop = getActiveCrop(annotations, imageWidth, imageHeight) ?? {
    x: 0,
    y: 0,
    width: imageWidth,
    height: imageHeight
  }
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(MIN_EXPORT_SIZE, Math.round(crop.width))
  canvas.height = Math.max(MIN_EXPORT_SIZE, Math.round(crop.height))
  const context = canvas.getContext('2d')
  if (!context) throw new Error('无法创建图像导出画布')

  const translated = annotations
    .filter((annotation) => annotation.tool !== 'crop')
    .map((annotation) => translateAnnotation(annotation, -crop.x, -crop.y))

  drawEditorScene(context, image, translated, {
    imageWidth,
    imageHeight,
    imageX: -crop.x,
    imageY: -crop.y,
    showCropMask: false
  })
  return canvas.toDataURL('image/png')
}
