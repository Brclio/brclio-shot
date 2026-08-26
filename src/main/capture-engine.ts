import type { CaptureRect, DesktopSourcePreview } from '../shared/types'

export type DesktopSourceKind = 'screen' | 'window'

export interface PixelSize {
  width: number
  height: number
}

export interface PixelRect extends PixelSize {
  x: number
  y: number
}

export interface NativeImageLike {
  crop: (rect: PixelRect) => NativeImageLike
  getSize: () => PixelSize
  isEmpty: () => boolean
  resize: (options: {
    width?: number
    height?: number
    quality?: 'good' | 'better' | 'best'
  }) => NativeImageLike
  toDataURL: () => string
  toPNG: () => Buffer
}

export interface DesktopSourceLike {
  id: string
  name: string
  thumbnail: NativeImageLike
  appIcon?: NativeImageLike | null
  display_id?: string
}

export interface DisplayLike {
  id: number | string
  bounds: CaptureRect
  scaleFactor: number
}

export interface CaptureEngineDependencies {
  desktopCapturer: {
    getSources: (options: {
      types: DesktopSourceKind[]
      thumbnailSize: PixelSize
      fetchWindowIcons?: boolean
    }) => Promise<DesktopSourceLike[]>
  }
  screen: {
    getAllDisplays: () => DisplayLike[]
    getCursorScreenPoint: () => { x: number; y: number }
    getDisplayNearestPoint: (point: { x: number; y: number }) => DisplayLike
  }
  nativeImage: {
    createFromBuffer: (buffer: Buffer) => NativeImageLike
  }
}

export interface ListSourcesOptions {
  thumbnailSize?: PixelSize
}

export interface CaptureSourceOptions {
  /**
   * desktopCapturer returns a thumbnail, so window captures request a large
   * thumbnail to retain the window's native pixels. Screen captures ignore
   * this value and use the physical dimensions reported by Electron's screen
   * module instead.
   */
  maxDimension?: number
}

export interface CaptureRegionOptions {
  /** Select a display explicitly when the overlay already knows its display. */
  displayId?: string | number
}

export interface CapturedImage {
  buffer: Buffer
  dataUrl: string
  width: number
  height: number
  sourceId: string
  sourceName: string
  kind: DesktopSourceKind
  displayId?: string
  scaleFactor?: number
  /** Global desktop coordinates in device-independent pixels. */
  boundsDip?: CaptureRect
  clipped?: boolean
}

export type CaptureEngineErrorCode =
  | 'INVALID_ARGUMENT'
  | 'SOURCE_NOT_FOUND'
  | 'DISPLAY_NOT_FOUND'
  | 'EMPTY_IMAGE'
  | 'REGION_OUTSIDE_DISPLAY'
  | 'IMAGE_TOO_LARGE'

export class CaptureEngineError extends Error {
  readonly code: CaptureEngineErrorCode
  readonly details?: Record<string, unknown>

  constructor(code: CaptureEngineErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'CaptureEngineError'
    this.code = code
    this.details = details
  }
}

const DEFAULT_PREVIEW_SIZE: PixelSize = { width: 480, height: 320 }
const DEFAULT_WINDOW_MAX_DIMENSION = 8192
const MAX_CAPTURE_DIMENSION = 16_384

function assertFinitePositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new CaptureEngineError('INVALID_ARGUMENT', `${label} must be a positive finite number`, {
      [label]: value
    })
  }
}

function normalizeSize(size: PixelSize, label: string): PixelSize {
  assertFinitePositive(size.width, `${label}.width`)
  assertFinitePositive(size.height, `${label}.height`)

  return {
    width: Math.min(MAX_CAPTURE_DIMENSION, Math.max(1, Math.round(size.width))),
    height: Math.min(MAX_CAPTURE_DIMENSION, Math.max(1, Math.round(size.height)))
  }
}

function displayIdOf(display: DisplayLike): string {
  return String(display.id)
}

function captureKindFromSourceId(sourceId: string): DesktopSourceKind | null {
  if (sourceId.startsWith('screen:')) return 'screen'
  if (sourceId.startsWith('window:')) return 'window'
  return null
}

function intersectionArea(a: CaptureRect, b: CaptureRect): number {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  return width * height
}

export function intersectCaptureRects(a: CaptureRect, b: CaptureRect): CaptureRect | null {
  const left = Math.max(a.x, b.x)
  const top = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)

  if (right <= left || bottom <= top) return null

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top
  }
}

/**
 * Convert a global DIP selection to a pixel crop within one display image.
 * Flooring the leading edges and ceiling the trailing edges ensures fractional
 * DIP selections never silently lose a boundary pixel.
 */
export function dipRectToPixelRect(
  selectionDip: CaptureRect,
  displayBoundsDip: CaptureRect,
  scaleFactor: number,
  imageSize?: PixelSize
): PixelRect | null {
  assertFinitePositive(selectionDip.width, 'selectionDip.width')
  assertFinitePositive(selectionDip.height, 'selectionDip.height')
  assertFinitePositive(displayBoundsDip.width, 'displayBoundsDip.width')
  assertFinitePositive(displayBoundsDip.height, 'displayBoundsDip.height')
  assertFinitePositive(scaleFactor, 'scaleFactor')

  const clipped = intersectCaptureRects(selectionDip, displayBoundsDip)
  if (!clipped) return null

  const limitWidth = imageSize?.width ?? Math.round(displayBoundsDip.width * scaleFactor)
  const limitHeight = imageSize?.height ?? Math.round(displayBoundsDip.height * scaleFactor)
  const left = Math.max(0, Math.floor((clipped.x - displayBoundsDip.x) * scaleFactor))
  const top = Math.max(0, Math.floor((clipped.y - displayBoundsDip.y) * scaleFactor))
  const right = Math.min(
    limitWidth,
    Math.ceil((clipped.x + clipped.width - displayBoundsDip.x) * scaleFactor)
  )
  const bottom = Math.min(
    limitHeight,
    Math.ceil((clipped.y + clipped.height - displayBoundsDip.y) * scaleFactor)
  )

  if (right <= left || bottom <= top) return null

  return { x: left, y: top, width: right - left, height: bottom - top }
}

function sourceDisplayId(source: DesktopSourceLike): string | undefined {
  return source.display_id && source.display_id.length > 0 ? source.display_id : undefined
}

function findDisplaySource(
  sources: DesktopSourceLike[],
  display: DisplayLike,
  displays: DisplayLike[]
): DesktopSourceLike | undefined {
  const targetId = displayIdOf(display)
  const exact = sources.find((source) => sourceDisplayId(source) === targetId)
  if (exact) return exact

  // Electron documents display_id as the stable mapping. A few platform/
  // permission combinations return an empty display_id, so use the screen
  // source index only as a deterministic fallback.
  const displayIndex = displays.findIndex((candidate) => displayIdOf(candidate) === targetId)
  return sources.find((source) => {
    const match = /^screen:(\d+):/.exec(source.id)
    return match ? Number(match[1]) === displayIndex : false
  })
}

function findDisplayForSource(
  source: DesktopSourceLike,
  displays: DisplayLike[]
): DisplayLike | undefined {
  const mappedId = sourceDisplayId(source)
  if (mappedId) {
    const exact = displays.find((display) => displayIdOf(display) === mappedId)
    if (exact) return exact
  }

  const sourceIndex = /^screen:(\d+):/.exec(source.id)?.[1]
  return sourceIndex === undefined ? undefined : displays[Number(sourceIndex)]
}

function imageResult(
  image: NativeImageLike,
  source: DesktopSourceLike,
  kind: DesktopSourceKind,
  extra: Partial<CapturedImage> = {}
): CapturedImage {
  if (image.isEmpty()) {
    throw new CaptureEngineError('EMPTY_IMAGE', `Desktop source ${source.id} returned an empty image`, {
      sourceId: source.id
    })
  }

  const size = image.getSize()
  if (
    size.width <= 0 ||
    size.height <= 0 ||
    size.width > MAX_CAPTURE_DIMENSION ||
    size.height > MAX_CAPTURE_DIMENSION
  ) {
    throw new CaptureEngineError('IMAGE_TOO_LARGE', 'Captured image dimensions are invalid or unsafe', {
      sourceId: source.id,
      size
    })
  }

  const buffer = image.toPNG()
  return {
    buffer,
    dataUrl: `data:image/png;base64,${buffer.toString('base64')}`,
    width: size.width,
    height: size.height,
    sourceId: source.id,
    sourceName: source.name,
    kind,
    ...extra
  }
}

async function loadElectronDependencies(): Promise<CaptureEngineDependencies> {
  const electron = await import('electron')
  return {
    desktopCapturer: electron.desktopCapturer as unknown as CaptureEngineDependencies['desktopCapturer'],
    screen: electron.screen as unknown as CaptureEngineDependencies['screen'],
    nativeImage: electron.nativeImage as unknown as CaptureEngineDependencies['nativeImage']
  }
}

export class CaptureEngine {
  private readonly dependenciesPromise: Promise<CaptureEngineDependencies>

  constructor(dependencies?: CaptureEngineDependencies) {
    this.dependenciesPromise = dependencies
      ? Promise.resolve(dependencies)
      : loadElectronDependencies()
  }

  async listSources(
    kind: DesktopSourceKind,
    options: ListSourcesOptions = {}
  ): Promise<DesktopSourcePreview[]> {
    const dependencies = await this.dependenciesPromise
    const thumbnailSize = normalizeSize(options.thumbnailSize ?? DEFAULT_PREVIEW_SIZE, 'thumbnailSize')
    const sources = await dependencies.desktopCapturer.getSources({
      types: [kind],
      thumbnailSize,
      fetchWindowIcons: kind === 'window'
    })
    const displays = kind === 'screen' ? dependencies.screen.getAllDisplays() : []

    return sources
      .filter((source) => !source.thumbnail.isEmpty())
      .map((source) => {
        const size = source.thumbnail.getSize()
        const mappedDisplay = findDisplayForSource(source, displays)
        return {
          id: source.id,
          name: source.name,
          kind,
          displayId: mappedDisplay ? displayIdOf(mappedDisplay) : sourceDisplayId(source),
          appIconDataUrl:
            source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.toDataURL() : undefined,
          thumbnailDataUrl: source.thumbnail.toDataURL(),
          width: size.width,
          height: size.height
        }
      })
  }

  async captureActiveDisplay(): Promise<CapturedImage> {
    const dependencies = await this.dependenciesPromise
    const cursorPoint = dependencies.screen.getCursorScreenPoint()
    const display = dependencies.screen.getDisplayNearestPoint(cursorPoint)
    return this.captureDisplay(display.id)
  }

  async captureDisplay(displayId: string | number): Promise<CapturedImage> {
    const dependencies = await this.dependenciesPromise
    const displays = dependencies.screen.getAllDisplays()
    const display = displays.find((candidate) => displayIdOf(candidate) === String(displayId))
    if (!display) {
      throw new CaptureEngineError('DISPLAY_NOT_FOUND', `Display ${String(displayId)} was not found`, {
        displayId: String(displayId)
      })
    }

    const requestedSize = normalizeSize(
      displays.reduce<PixelSize>(
        (largest, candidate) => ({
          width: Math.max(largest.width, candidate.bounds.width * candidate.scaleFactor),
          height: Math.max(largest.height, candidate.bounds.height * candidate.scaleFactor)
        }),
        { width: 1, height: 1 }
      ),
      'displayCaptureSize'
    )
    const sources = await dependencies.desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: requestedSize,
      fetchWindowIcons: false
    })
    const source = findDisplaySource(sources, display, displays)
    if (!source) {
      throw new CaptureEngineError('SOURCE_NOT_FOUND', 'No desktop source matched the requested display', {
        displayId: displayIdOf(display),
        availableSourceIds: sources.map((candidate) => candidate.id)
      })
    }

    let image = dependencies.nativeImage.createFromBuffer(source.thumbnail.toPNG())
    const rawExpectedSize = {
      width: display.bounds.width * display.scaleFactor,
      height: display.bounds.height * display.scaleFactor
    }
    if (
      rawExpectedSize.width > MAX_CAPTURE_DIMENSION ||
      rawExpectedSize.height > MAX_CAPTURE_DIMENSION
    ) {
      throw new CaptureEngineError('IMAGE_TOO_LARGE', 'Display exceeds the safe capture dimensions', {
        displayId: displayIdOf(display),
        size: rawExpectedSize,
        maxDimension: MAX_CAPTURE_DIMENSION
      })
    }
    const expectedSize = normalizeSize(rawExpectedSize, 'displayPixelSize')
    const actualSize = image.getSize()
    if (actualSize.width !== expectedSize.width || actualSize.height !== expectedSize.height) {
      image = image.resize({ ...expectedSize, quality: 'best' })
    }

    return imageResult(image, source, 'screen', {
      displayId: displayIdOf(display),
      scaleFactor: display.scaleFactor,
      boundsDip: { ...display.bounds }
    })
  }

  async captureSource(
    sourceId: string,
    options: CaptureSourceOptions = {}
  ): Promise<CapturedImage> {
    if (!sourceId) {
      throw new CaptureEngineError('INVALID_ARGUMENT', 'sourceId must not be empty')
    }

    const dependencies = await this.dependenciesPromise
    const hintedKind = captureKindFromSourceId(sourceId)
    const kinds: DesktopSourceKind[] = hintedKind ? [hintedKind] : ['screen', 'window']
    const displays = dependencies.screen.getAllDisplays()
    const maxDimension = Math.min(
      MAX_CAPTURE_DIMENSION,
      Math.max(1, Math.round(options.maxDimension ?? DEFAULT_WINDOW_MAX_DIMENSION))
    )
    const screenSize = displays.reduce<PixelSize>(
      (largest, display) => ({
        width: Math.max(largest.width, display.bounds.width * display.scaleFactor),
        height: Math.max(largest.height, display.bounds.height * display.scaleFactor)
      }),
      { width: 1, height: 1 }
    )
    const thumbnailSize = normalizeSize(
      hintedKind === 'screen'
        ? screenSize
        : { width: maxDimension, height: maxDimension },
      'sourceCaptureSize'
    )
    const sources = await dependencies.desktopCapturer.getSources({
      types: kinds,
      thumbnailSize,
      fetchWindowIcons: kinds.includes('window')
    })
    const source = sources.find((candidate) => candidate.id === sourceId)
    if (!source) {
      throw new CaptureEngineError('SOURCE_NOT_FOUND', `Desktop source ${sourceId} was not found`, {
        sourceId
      })
    }

    const kind = captureKindFromSourceId(source.id) ?? hintedKind ?? 'window'
    const display = kind === 'screen' ? findDisplayForSource(source, displays) : undefined

    if (display) return this.captureDisplay(display.id)

    const image = dependencies.nativeImage.createFromBuffer(source.thumbnail.toPNG())
    return imageResult(image, source, kind, {
      displayId: sourceDisplayId(source)
    })
  }

  async captureRegion(
    selectionDip: CaptureRect,
    options: CaptureRegionOptions = {}
  ): Promise<CapturedImage> {
    assertFinitePositive(selectionDip.width, 'selectionDip.width')
    assertFinitePositive(selectionDip.height, 'selectionDip.height')
    if (!Number.isFinite(selectionDip.x) || !Number.isFinite(selectionDip.y)) {
      throw new CaptureEngineError('INVALID_ARGUMENT', 'selectionDip coordinates must be finite', {
        selectionDip
      })
    }

    const dependencies = await this.dependenciesPromise
    const displays = dependencies.screen.getAllDisplays()
    const requestedDisplay =
      options.displayId === undefined
        ? undefined
        : displays.find((display) => displayIdOf(display) === String(options.displayId))

    if (options.displayId !== undefined && !requestedDisplay) {
      throw new CaptureEngineError(
        'DISPLAY_NOT_FOUND',
        `Display ${String(options.displayId)} was not found`,
        { displayId: String(options.displayId) }
      )
    }

    const display =
      requestedDisplay ??
      displays.reduce<DisplayLike | undefined>((best, candidate) => {
        if (!best) return candidate
        return intersectionArea(selectionDip, candidate.bounds) >
          intersectionArea(selectionDip, best.bounds)
          ? candidate
          : best
      }, undefined)

    if (!display || intersectionArea(selectionDip, display.bounds) === 0) {
      throw new CaptureEngineError(
        'REGION_OUTSIDE_DISPLAY',
        'The selected region does not intersect an available display',
        { selectionDip }
      )
    }

    const displayCapture = await this.captureDisplay(display.id)
    const displayImage = dependencies.nativeImage.createFromBuffer(displayCapture.buffer)
    const pixelRect = dipRectToPixelRect(
      selectionDip,
      display.bounds,
      display.scaleFactor,
      displayImage.getSize()
    )
    const clippedBounds = intersectCaptureRects(selectionDip, display.bounds)
    if (!pixelRect || !clippedBounds) {
      throw new CaptureEngineError(
        'REGION_OUTSIDE_DISPLAY',
        'The selected region does not intersect the requested display',
        { selectionDip, displayId: displayIdOf(display) }
      )
    }

    const croppedImage = displayImage.crop(pixelRect)
    const source: DesktopSourceLike = {
      id: displayCapture.sourceId,
      name: displayCapture.sourceName,
      thumbnail: croppedImage,
      display_id: displayIdOf(display)
    }

    return imageResult(croppedImage, source, 'screen', {
      displayId: displayIdOf(display),
      scaleFactor: display.scaleFactor,
      boundsDip: clippedBounds,
      clipped:
        clippedBounds.x !== selectionDip.x ||
        clippedBounds.y !== selectionDip.y ||
        clippedBounds.width !== selectionDip.width ||
        clippedBounds.height !== selectionDip.height
    })
  }
}

export function createCaptureEngine(dependencies?: CaptureEngineDependencies): CaptureEngine {
  return new CaptureEngine(dependencies)
}
