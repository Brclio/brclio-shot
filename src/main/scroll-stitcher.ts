import sharp from 'sharp'

export interface RawImage {
  data: Uint8Array
  width: number
  height: number
  channels: 3 | 4
}

export interface OverlapEstimationOptions {
  minOverlapPixels?: number
  maxOverlapRatio?: number
  minNewPixels?: number
  similarityThreshold?: number
  reliabilityThreshold?: number
  duplicateThreshold?: number
  colorTolerance?: number
  sampleColumns?: number
  sampleRows?: number
  ambiguityRadius?: number
  /** Ignore a fixed/sticky band at the top while comparing candidates. */
  comparisonTopInset?: number
  /** Ignore a fixed/sticky band at the bottom while comparing candidates. */
  comparisonBottomInset?: number
}

export interface OverlapEstimate {
  overlapPixels: number
  scrollOffsetPixels: number
  newPixels: number
  similarity: number
  secondBestSimilarity: number
  confidence: number
  reliable: boolean
  duplicate: boolean
  comparedPixels: number
}

export interface StaticEdgeInsets {
  top: number
  bottom: number
}

export interface StaticEdgeDetectionOptions {
  similarityThreshold?: number
  minStaticPixels?: number
  maxStaticRatio?: number
  sampleColumns?: number
  colorTolerance?: number
}

export type WidthMismatchStrategy = 'reject' | 'crop-to-smallest'
export type UnreliableOverlapStrategy = 'reject' | 'append'

export interface ScrollStitchOptions extends OverlapEstimationOptions {
  maxFrames?: number
  maxInputDimension?: number
  maxInputPixels?: number
  /** Aggregate decoded-pixel budget; RGBA decoding uses four bytes per pixel. */
  maxTotalInputPixels?: number
  maxOutputHeight?: number
  maxOutputPixels?: number
  widthMismatchStrategy?: WidthMismatchStrategy
  unreliableOverlapStrategy?: UnreliableOverlapStrategy
  detectStaticEdges?: boolean
  staticEdgeSimilarityThreshold?: number
  minStaticEdgePixels?: number
  maxStaticEdgeRatio?: number
}

export interface StitchOverlap extends OverlapEstimate {
  previousFrameIndex: number
  currentFrameIndex: number
}

export interface ScrollStitchResult {
  buffer: Buffer
  width: number
  height: number
  frameCount: number
  uniqueFrameCount: number
  droppedDuplicateFrames: number
  overlaps: StitchOverlap[]
  staticInsets: StaticEdgeInsets
  warnings: string[]
}

export type ScrollStitchErrorCode =
  | 'NO_FRAMES'
  | 'TOO_MANY_FRAMES'
  | 'INVALID_IMAGE'
  | 'INPUT_TOO_LARGE'
  | 'WIDTH_MISMATCH'
  | 'UNRELIABLE_OVERLAP'
  | 'OUTPUT_TOO_LARGE'

export class ScrollStitchError extends Error {
  readonly code: ScrollStitchErrorCode
  readonly details?: Record<string, unknown>

  constructor(code: ScrollStitchErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'ScrollStitchError'
    this.code = code
    this.details = details
  }
}

interface ResolvedOverlapOptions {
  minOverlapPixels: number
  maxOverlapRatio: number
  minNewPixels: number
  similarityThreshold: number
  reliabilityThreshold: number
  duplicateThreshold: number
  colorTolerance: number
  sampleColumns: number
  sampleRows: number
  ambiguityRadius: number
  comparisonTopInset: number
  comparisonBottomInset: number
}

interface CandidateScore {
  overlap: number
  similarity: number
  comparedPixels: number
}

interface IndexedRawImage {
  image: RawImage
  originalIndex: number
}

interface StitchSegment {
  image: RawImage
  top: number
  bottom: number
}

const DEFAULT_MAX_FRAMES = 120
const DEFAULT_MAX_INPUT_DIMENSION = 16_384
const DEFAULT_MAX_INPUT_PIXELS = 50_000_000
const DEFAULT_MAX_TOTAL_INPUT_PIXELS = 250_000_000
const DEFAULT_MAX_OUTPUT_HEIGHT = 100_000
const DEFAULT_MAX_OUTPUT_PIXELS = 200_000_000

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function finiteInteger(value: number | undefined, fallback: number, minimum: number): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value)) return fallback
  return Math.max(minimum, Math.round(value))
}

function finiteRatio(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return clamp(value, 0, 1)
}

function resolveOverlapOptions(options: OverlapEstimationOptions = {}): ResolvedOverlapOptions {
  return {
    minOverlapPixels: finiteInteger(options.minOverlapPixels, 24, 1),
    maxOverlapRatio: finiteRatio(options.maxOverlapRatio, 0.98),
    minNewPixels: finiteInteger(options.minNewPixels, 4, 1),
    similarityThreshold: finiteRatio(options.similarityThreshold, 0.86),
    reliabilityThreshold: finiteRatio(options.reliabilityThreshold, 0.72),
    duplicateThreshold: finiteRatio(options.duplicateThreshold, 0.995),
    colorTolerance: finiteInteger(options.colorTolerance, 18, 0),
    sampleColumns: finiteInteger(options.sampleColumns, 128, 1),
    sampleRows: finiteInteger(options.sampleRows, 40, 1),
    ambiguityRadius: finiteInteger(options.ambiguityRadius, 2, 0),
    comparisonTopInset: finiteInteger(options.comparisonTopInset, 0, 0),
    comparisonBottomInset: finiteInteger(options.comparisonBottomInset, 0, 0)
  }
}

function assertRawImage(image: RawImage, label: string): void {
  if (
    !Number.isInteger(image.width) ||
    !Number.isInteger(image.height) ||
    image.width <= 0 ||
    image.height <= 0 ||
    (image.channels !== 3 && image.channels !== 4)
  ) {
    throw new ScrollStitchError('INVALID_IMAGE', `${label} has invalid dimensions or channels`, {
      width: image.width,
      height: image.height,
      channels: image.channels
    })
  }

  const expectedBytes = image.width * image.height * image.channels
  if (image.data.byteLength < expectedBytes) {
    throw new ScrollStitchError('INVALID_IMAGE', `${label} has truncated pixel data`, {
      expectedBytes,
      actualBytes: image.data.byteLength
    })
  }
}

function pixelOffset(image: RawImage, x: number, y: number): number {
  return (y * image.width + x) * image.channels
}

function samplePositions(length: number, desiredCount: number): number[] {
  const count = Math.min(length, Math.max(1, desiredCount))
  if (count === length) return Array.from({ length }, (_, index) => index)

  const positions = new Array<number>(count)
  for (let index = 0; index < count; index += 1) {
    positions[index] = Math.min(length - 1, Math.floor(((index + 0.5) * length) / count))
  }
  return positions
}

function compareSampleGrid(
  first: RawImage,
  second: RawImage,
  firstStartY: number,
  secondStartY: number,
  height: number,
  sampleColumns: number,
  sampleRows: number,
  colorTolerance: number
): { similarity: number; comparedPixels: number } {
  const width = Math.min(first.width, second.width)
  if (width <= 0 || height <= 0) return { similarity: 0, comparedPixels: 0 }

  const xPositions = samplePositions(width, sampleColumns)
  const yPositions = samplePositions(height, sampleRows)
  let absoluteDifference = 0
  let closePixels = 0
  let comparedPixels = 0

  for (const relativeY of yPositions) {
    const firstY = firstStartY + relativeY
    const secondY = secondStartY + relativeY
    if (
      firstY < 0 ||
      secondY < 0 ||
      firstY >= first.height ||
      secondY >= second.height
    ) {
      continue
    }

    for (const x of xPositions) {
      const firstOffset = pixelOffset(first, x, firstY)
      const secondOffset = pixelOffset(second, x, secondY)
      const redDifference = Math.abs(first.data[firstOffset] - second.data[secondOffset])
      const greenDifference = Math.abs(first.data[firstOffset + 1] - second.data[secondOffset + 1])
      const blueDifference = Math.abs(first.data[firstOffset + 2] - second.data[secondOffset + 2])
      absoluteDifference += redDifference + greenDifference + blueDifference
      if (
        redDifference <= colorTolerance &&
        greenDifference <= colorTolerance &&
        blueDifference <= colorTolerance
      ) {
        closePixels += 1
      }
      comparedPixels += 1
    }
  }

  if (comparedPixels === 0) return { similarity: 0, comparedPixels: 0 }

  const colorSimilarity = 1 - absoluteDifference / (comparedPixels * 3 * 255)
  const closeRatio = closePixels / comparedPixels
  return {
    similarity: clamp(colorSimilarity * 0.65 + closeRatio * 0.35, 0, 1),
    comparedPixels
  }
}

/** Return a sampled 0..1 similarity for two equally aligned images. */
export function calculateImageSimilarity(
  first: RawImage,
  second: RawImage,
  options: Pick<
    OverlapEstimationOptions,
    'sampleColumns' | 'sampleRows' | 'colorTolerance'
  > = {}
): number {
  assertRawImage(first, 'first image')
  assertRawImage(second, 'second image')
  if (first.width !== second.width || first.height !== second.height) return 0

  const resolved = resolveOverlapOptions(options)
  return compareSampleGrid(
    first,
    second,
    0,
    0,
    first.height,
    resolved.sampleColumns,
    Math.max(resolved.sampleRows, 80),
    resolved.colorTolerance
  ).similarity
}

function estimateImageInformation(image: RawImage, sampleColumns: number, sampleRows: number): number {
  const xPositions = samplePositions(image.width, Math.min(sampleColumns, 64))
  const yPositions = samplePositions(image.height, Math.min(sampleRows, 64))
  let sum = 0
  let squaredSum = 0
  let count = 0

  for (const y of yPositions) {
    for (const x of xPositions) {
      const offset = pixelOffset(image, x, y)
      const luminance =
        image.data[offset] * 0.2126 +
        image.data[offset + 1] * 0.7152 +
        image.data[offset + 2] * 0.0722
      sum += luminance
      squaredSum += luminance * luminance
      count += 1
    }
  }

  if (count === 0) return 0
  const mean = sum / count
  const variance = Math.max(0, squaredSum / count - mean * mean)
  return clamp(Math.sqrt(variance) / 48, 0, 1)
}

function scoreOverlapCandidate(
  previous: RawImage,
  current: RawImage,
  overlap: number,
  options: ResolvedOverlapOptions
): CandidateScore {
  const topInset = Math.min(options.comparisonTopInset, Math.max(0, overlap - 1))
  const bottomInset = Math.min(options.comparisonBottomInset, previous.height - 1)
  // `overlap` is the first row to append from the current frame. A sticky
  // header is therefore inside the skipped prefix, while a sticky footer is
  // excluded from the tail of the previous frame.
  const comparisonHeight = overlap - topInset
  const previousStartY = previous.height - bottomInset - comparisonHeight
  if (previousStartY < 0 || comparisonHeight <= 0) {
    return { overlap, similarity: 0, comparedPixels: 0 }
  }
  const score = compareSampleGrid(
    previous,
    current,
    previousStartY,
    topInset,
    comparisonHeight,
    options.sampleColumns,
    options.sampleRows,
    options.colorTolerance
  )
  return { overlap, ...score }
}

/**
 * Estimate how many rows at the bottom of `previous` reappear at the top of
 * `current`. The estimator is deliberately independent of Sharp/Electron so
 * synthetic fixtures can cover matching, ambiguity and deduplication.
 */
export function estimateVerticalOverlap(
  previous: RawImage,
  current: RawImage,
  options: OverlapEstimationOptions = {}
): OverlapEstimate {
  assertRawImage(previous, 'previous image')
  assertRawImage(current, 'current image')

  if (previous.width !== current.width) {
    return {
      overlapPixels: 0,
      scrollOffsetPixels: previous.height,
      newPixels: current.height,
      similarity: 0,
      secondBestSimilarity: 0,
      confidence: 0,
      reliable: false,
      duplicate: false,
      comparedPixels: 0
    }
  }

  const resolved = resolveOverlapOptions(options)
  if (previous.height === current.height) {
    const duplicateSimilarity = calculateImageSimilarity(previous, current, resolved)
    if (duplicateSimilarity >= resolved.duplicateThreshold) {
      return {
        overlapPixels: current.height,
        scrollOffsetPixels: 0,
        newPixels: 0,
        similarity: duplicateSimilarity,
        secondBestSimilarity: 0,
        confidence: duplicateSimilarity,
        reliable: true,
        duplicate: true,
        comparedPixels: previous.width * previous.height
      }
    }
  }

  const shortestHeight = Math.min(previous.height, current.height)
  const minimumComparedPixels = resolved.comparisonTopInset + 1
  const minimumOverlap = Math.max(resolved.minOverlapPixels, minimumComparedPixels)
  const maximumOverlap = Math.min(
    shortestHeight - resolved.minNewPixels,
    previous.height - resolved.comparisonBottomInset,
    Math.floor(shortestHeight * resolved.maxOverlapRatio)
  )

  if (maximumOverlap < minimumOverlap) {
    return {
      overlapPixels: 0,
      scrollOffsetPixels: previous.height,
      newPixels: current.height,
      similarity: 0,
      secondBestSimilarity: 0,
      confidence: 0,
      reliable: false,
      duplicate: false,
      comparedPixels: 0
    }
  }

  const candidates: CandidateScore[] = []
  for (let overlap = minimumOverlap; overlap <= maximumOverlap; overlap += 1) {
    candidates.push(scoreOverlapCandidate(previous, current, overlap, resolved))
  }
  candidates.sort((first, second) => second.similarity - first.similarity)

  const best = candidates[0]
  const secondBest = candidates.find(
    (candidate) => Math.abs(candidate.overlap - best.overlap) > resolved.ambiguityRadius
  )
  const secondBestSimilarity = secondBest?.similarity ?? 0
  const separation = clamp((best.similarity - secondBestSimilarity) * 5, 0, 1)
  const information =
    (estimateImageInformation(previous, resolved.sampleColumns, resolved.sampleRows) +
      estimateImageInformation(current, resolved.sampleColumns, resolved.sampleRows)) /
    2
  const confidence = clamp(
    best.similarity * (0.6 + separation * 0.3 + information * 0.1),
    0,
    1
  )
  const reliable =
    best.similarity >= resolved.similarityThreshold &&
    confidence >= resolved.reliabilityThreshold

  return {
    overlapPixels: best.overlap,
    scrollOffsetPixels:
      previous.height - resolved.comparisonBottomInset - best.overlap,
    newPixels: current.height - best.overlap,
    similarity: best.similarity,
    secondBestSimilarity,
    confidence,
    reliable,
    duplicate: false,
    comparedPixels: best.comparedPixels
  }
}

function rowSimilarity(
  first: RawImage,
  second: RawImage,
  firstY: number,
  secondY: number,
  sampleColumns: number,
  colorTolerance: number
): number {
  return compareSampleGrid(
    first,
    second,
    firstY,
    secondY,
    1,
    sampleColumns,
    1,
    colorTolerance
  ).similarity
}

/** Detect fixed header/footer bands shared at the same coordinates in every frame. */
export function detectStableEdgeInsets(
  frames: RawImage[],
  options: StaticEdgeDetectionOptions = {}
): StaticEdgeInsets {
  if (frames.length < 2) return { top: 0, bottom: 0 }
  for (const [index, frame] of frames.entries()) assertRawImage(frame, `frame ${index}`)

  const minimumHeight = Math.min(...frames.map((frame) => frame.height))
  const threshold = finiteRatio(options.similarityThreshold, 0.985)
  const minimumStaticPixels = finiteInteger(options.minStaticPixels, 8, 1)
  const maximumStaticPixels = Math.floor(
    minimumHeight * finiteRatio(options.maxStaticRatio, 0.2)
  )
  const sampleColumns = finiteInteger(options.sampleColumns, 128, 1)
  const colorTolerance = finiteInteger(options.colorTolerance, 18, 0)

  const isStableTopRow = (offset: number): boolean => {
    for (let index = 1; index < frames.length; index += 1) {
      if (
        rowSimilarity(
          frames[index - 1],
          frames[index],
          offset,
          offset,
          sampleColumns,
          colorTolerance
        ) < threshold
      ) {
        return false
      }
    }
    return true
  }

  const isStableBottomRow = (offset: number): boolean => {
    for (let index = 1; index < frames.length; index += 1) {
      const previous = frames[index - 1]
      const current = frames[index]
      if (
        rowSimilarity(
          previous,
          current,
          previous.height - 1 - offset,
          current.height - 1 - offset,
          sampleColumns,
          colorTolerance
        ) <
        threshold
      ) {
        return false
      }
    }
    return true
  }

  let top = 0
  while (top < maximumStaticPixels && isStableTopRow(top)) top += 1

  let bottom = 0
  while (
    bottom < maximumStaticPixels &&
    top + bottom < minimumHeight &&
    isStableBottomRow(bottom)
  ) {
    bottom += 1
  }

  return {
    top: top >= minimumStaticPixels ? top : 0,
    bottom: bottom >= minimumStaticPixels ? bottom : 0
  }
}

function cropRawHorizontally(image: RawImage, targetWidth: number): RawImage {
  if (image.width === targetWidth) return image
  const left = Math.floor((image.width - targetWidth) / 2)
  const data = Buffer.allocUnsafe(targetWidth * image.height * image.channels)
  const sourceRowBytes = image.width * image.channels
  const targetRowBytes = targetWidth * image.channels
  const sourceStartOffset = left * image.channels

  for (let y = 0; y < image.height; y += 1) {
    const sourceStart = y * sourceRowBytes + sourceStartOffset
    data.set(image.data.subarray(sourceStart, sourceStart + targetRowBytes), y * targetRowBytes)
  }

  return { data, width: targetWidth, height: image.height, channels: image.channels }
}

function cropRawSegment(segment: StitchSegment): RawImage {
  const { image, top, bottom } = segment
  const height = bottom - top
  const rowBytes = image.width * image.channels
  const start = top * rowBytes
  const end = bottom * rowBytes
  return {
    data: image.data.subarray(start, end),
    width: image.width,
    height,
    channels: image.channels
  }
}

async function decodeFrame(
  input: Buffer,
  frameIndex: number,
  maxInputDimension: number,
  maxInputPixels: number
): Promise<RawImage> {
  if (!Buffer.isBuffer(input) || input.byteLength === 0) {
    throw new ScrollStitchError('INVALID_IMAGE', `Frame ${frameIndex} is empty`, { frameIndex })
  }

  let metadata: {
    width?: number
    height?: number
    pages?: number
  }
  try {
    metadata = await sharp(input, {
      limitInputPixels: maxInputPixels,
      sequentialRead: true,
      animated: false
    }).metadata()
  } catch (error) {
    throw new ScrollStitchError('INVALID_IMAGE', `Frame ${frameIndex} cannot be decoded`, {
      frameIndex,
      cause: error instanceof Error ? error.message : String(error)
    })
  }

  const width = metadata.width ?? 0
  const height = metadata.height ?? 0
  if (
    width <= 0 ||
    height <= 0 ||
    width > maxInputDimension ||
    height > maxInputDimension ||
    width * height > maxInputPixels
  ) {
    throw new ScrollStitchError('INPUT_TOO_LARGE', `Frame ${frameIndex} exceeds input limits`, {
      frameIndex,
      width,
      height,
      maxInputDimension,
      maxInputPixels
    })
  }
  if ((metadata.pages ?? 1) > 1) {
    throw new ScrollStitchError('INVALID_IMAGE', 'Animated or multi-page frames are not supported', {
      frameIndex,
      pages: metadata.pages
    })
  }

  try {
    const { data, info } = await sharp(input, {
      limitInputPixels: maxInputPixels,
      sequentialRead: true,
      animated: false
    })
      .rotate()
      .toColourspace('srgb')
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })

    if (
      info.width > maxInputDimension ||
      info.height > maxInputDimension ||
      info.width * info.height > maxInputPixels
    ) {
      throw new ScrollStitchError('INPUT_TOO_LARGE', `Frame ${frameIndex} exceeds input limits`, {
        frameIndex,
        width: info.width,
        height: info.height
      })
    }

    return {
      data,
      width: info.width,
      height: info.height,
      channels: 4
    }
  } catch (error) {
    if (error instanceof ScrollStitchError) throw error
    throw new ScrollStitchError('INVALID_IMAGE', `Frame ${frameIndex} cannot be normalized`, {
      frameIndex,
      cause: error instanceof Error ? error.message : String(error)
    })
  }
}

/**
 * Decode, deduplicate and vertically stitch scrolling-capture frames. PNG is
 * used for the output so the main process can save, copy or edit it losslessly.
 */
export async function stitchScrollFrames(
  frames: Buffer[],
  options: ScrollStitchOptions = {}
): Promise<ScrollStitchResult> {
  if (frames.length === 0) {
    throw new ScrollStitchError('NO_FRAMES', 'At least one frame is required')
  }

  const maxFrames = finiteInteger(options.maxFrames, DEFAULT_MAX_FRAMES, 1)
  if (frames.length > maxFrames) {
    throw new ScrollStitchError('TOO_MANY_FRAMES', 'Frame count exceeds the configured limit', {
      frameCount: frames.length,
      maxFrames
    })
  }

  const maxInputDimension = finiteInteger(
    options.maxInputDimension,
    DEFAULT_MAX_INPUT_DIMENSION,
    1
  )
  const maxInputPixels = finiteInteger(options.maxInputPixels, DEFAULT_MAX_INPUT_PIXELS, 1)
  const maxTotalInputPixels = finiteInteger(
    options.maxTotalInputPixels,
    DEFAULT_MAX_TOTAL_INPUT_PIXELS,
    1
  )
  const maxOutputHeight = finiteInteger(
    options.maxOutputHeight,
    DEFAULT_MAX_OUTPUT_HEIGHT,
    1
  )
  const maxOutputPixels = finiteInteger(
    options.maxOutputPixels,
    DEFAULT_MAX_OUTPUT_PIXELS,
    1
  )
  const widthStrategy = options.widthMismatchStrategy ?? 'reject'
  const unreliableStrategy = options.unreliableOverlapStrategy ?? 'reject'
  const warnings: string[] = []

  const decoded: IndexedRawImage[] = []
  let totalInputPixels = 0
  for (let index = 0; index < frames.length; index += 1) {
    const image = await decodeFrame(frames[index], index, maxInputDimension, maxInputPixels)
    totalInputPixels += image.width * image.height
    if (totalInputPixels > maxTotalInputPixels) {
      throw new ScrollStitchError(
        'INPUT_TOO_LARGE',
        'Combined decoded frames exceed the configured memory budget',
        { totalInputPixels, maxTotalInputPixels, frameIndex: index }
      )
    }
    decoded.push({ image, originalIndex: index })
  }

  const widths = decoded.map(({ image }) => image.width)
  const targetWidth = Math.min(...widths)
  if (!widths.every((width) => width === targetWidth)) {
    if (widthStrategy === 'reject') {
      throw new ScrollStitchError('WIDTH_MISMATCH', 'All scrolling frames must have the same width', {
        widths
      })
    }
    for (const entry of decoded) entry.image = cropRawHorizontally(entry.image, targetWidth)
    warnings.push(`Frame widths differed and were center-cropped to ${targetWidth}px.`)
  }

  const resolvedOverlap = resolveOverlapOptions(options)
  const unique: IndexedRawImage[] = []
  let droppedDuplicateFrames = 0
  for (const entry of decoded) {
    const previous = unique.at(-1)
    if (
      previous &&
      previous.image.width === entry.image.width &&
      previous.image.height === entry.image.height &&
      calculateImageSimilarity(previous.image, entry.image, resolvedOverlap) >=
        resolvedOverlap.duplicateThreshold
    ) {
      droppedDuplicateFrames += 1
      continue
    }
    unique.push(entry)
  }

  const staticInsets =
    options.detectStaticEdges === false
      ? { top: 0, bottom: 0 }
      : detectStableEdgeInsets(
          unique.map((entry) => entry.image),
          {
            similarityThreshold: options.staticEdgeSimilarityThreshold,
            minStaticPixels: options.minStaticEdgePixels,
            maxStaticRatio: options.maxStaticEdgeRatio,
            sampleColumns: resolvedOverlap.sampleColumns,
            colorTolerance: resolvedOverlap.colorTolerance
          }
        )

  const overlaps: StitchOverlap[] = []
  const resolvedWithInsets: OverlapEstimationOptions = {
    ...options,
    comparisonTopInset: Math.max(resolvedOverlap.comparisonTopInset, staticInsets.top),
    comparisonBottomInset: Math.max(resolvedOverlap.comparisonBottomInset, staticInsets.bottom)
  }

  for (let index = 1; index < unique.length; index += 1) {
    const previous = unique[index - 1]
    const current = unique[index]
    let estimate = estimateVerticalOverlap(previous.image, current.image, resolvedWithInsets)

    if (estimate.duplicate) {
      // Non-consecutive duplicates are retained by the first pass only if an
      // intervening frame exists. At this stage they are still safe to skip.
      droppedDuplicateFrames += 1
      estimate = { ...estimate, newPixels: 0 }
    } else if (!estimate.reliable) {
      if (unreliableStrategy === 'reject') {
        throw new ScrollStitchError(
          'UNRELIABLE_OVERLAP',
          `Could not reliably align frames ${previous.originalIndex} and ${current.originalIndex}`,
          {
            previousFrameIndex: previous.originalIndex,
            currentFrameIndex: current.originalIndex,
            estimate
          }
        )
      }
      warnings.push(
        `Frames ${previous.originalIndex} and ${current.originalIndex} had no reliable overlap and were appended.`
      )
      estimate = {
        ...estimate,
        overlapPixels: 0,
        scrollOffsetPixels: previous.image.height,
        newPixels: current.image.height
      }
    }

    overlaps.push({
      ...estimate,
      previousFrameIndex: previous.originalIndex,
      currentFrameIndex: current.originalIndex
    })
  }

  const segments: StitchSegment[] = []
  if (unique.length === 1) {
    segments.push({ image: unique[0].image, top: 0, bottom: unique[0].image.height })
  } else {
    const first = unique[0].image
    segments.push({ image: first, top: 0, bottom: first.height - staticInsets.bottom })

    for (let index = 1; index < unique.length; index += 1) {
      const image = unique[index].image
      const overlap = overlaps[index - 1]?.overlapPixels ?? 0
      const isLast = index === unique.length - 1
      const bottom = isLast ? image.height : image.height - staticInsets.bottom
      if (overlap < bottom) segments.push({ image, top: overlap, bottom })
    }
  }

  const outputHeight = segments.reduce((sum, segment) => sum + segment.bottom - segment.top, 0)
  const outputPixels = targetWidth * outputHeight
  if (
    outputHeight <= 0 ||
    outputHeight > maxOutputHeight ||
    outputPixels > maxOutputPixels
  ) {
    throw new ScrollStitchError('OUTPUT_TOO_LARGE', 'Stitched output exceeds safety limits', {
      width: targetWidth,
      height: outputHeight,
      pixels: outputPixels,
      maxOutputHeight,
      maxOutputPixels
    })
  }

  const compositeInputs: Array<{
    input: Buffer
    raw: { width: number; height: number; channels: 3 | 4 }
    left: number
    top: number
  }> = []
  let top = 0
  for (const segment of segments) {
    const cropped = cropRawSegment(segment)
    compositeInputs.push({
      input: Buffer.from(cropped.data),
      raw: { width: cropped.width, height: cropped.height, channels: cropped.channels },
      left: 0,
      top
    })
    top += cropped.height
  }

  const buffer = await sharp({
    create: {
      width: targetWidth,
      height: outputHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  })
    .composite(compositeInputs)
    .png({ compressionLevel: 6, adaptiveFiltering: true })
    .toBuffer()

  return {
    buffer,
    width: targetWidth,
    height: outputHeight,
    frameCount: frames.length,
    uniqueFrameCount: unique.length,
    droppedDuplicateFrames,
    overlaps,
    staticInsets,
    warnings
  }
}
