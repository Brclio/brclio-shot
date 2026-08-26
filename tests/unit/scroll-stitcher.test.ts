import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import {
  ScrollStitchError,
  detectStableEdgeInsets,
  estimateVerticalOverlap,
  stitchScrollFrames,
  type RawImage
} from '../../src/main/scroll-stitcher'

function createDocument(width: number, height: number, seed = 0x9e3779b9): RawImage {
  const data = Buffer.alloc(width * height * 4)
  let state = seed >>> 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      state ^= state << 13
      state ^= state >>> 17
      state ^= state << 5
      const offset = (y * width + x) * 4
      data[offset] = (state + x * 17 + y * 3) & 0xff
      data[offset + 1] = ((state >>> 8) + x * 5 + y * 19) & 0xff
      data[offset + 2] = ((state >>> 16) + x * 11 + y * 7) & 0xff
      data[offset + 3] = 255
    }
  }
  return { data, width, height, channels: 4 }
}

function sliceRows(image: RawImage, start: number, height: number): RawImage {
  const rowBytes = image.width * image.channels
  return {
    data: image.data.slice(start * rowBytes, (start + height) * rowBytes),
    width: image.width,
    height,
    channels: image.channels
  }
}

async function encodePng(image: RawImage): Promise<Buffer> {
  return sharp(Buffer.from(image.data), {
    raw: { width: image.width, height: image.height, channels: image.channels }
  })
    .png()
    .toBuffer()
}

async function decodePng(buffer: Buffer): Promise<RawImage> {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height, channels: 4 }
}

function solidFrame(width: number, height: number, rgb: [number, number, number]): RawImage {
  const data = Buffer.alloc(width * height * 4)
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4
    data[offset] = rgb[0]
    data[offset + 1] = rgb[1]
    data[offset + 2] = rgb[2]
    data[offset + 3] = 255
  }
  return { data, width, height, channels: 4 }
}

describe('estimateVerticalOverlap', () => {
  it('finds an exact vertical overlap and reports a reliable confidence', () => {
    const document = createDocument(48, 140)
    const previous = sliceRows(document, 0, 80)
    const current = sliceRows(document, 30, 80)

    const estimate = estimateVerticalOverlap(previous, current, {
      minOverlapPixels: 12,
      sampleColumns: 48,
      sampleRows: 40
    })

    expect(estimate.overlapPixels).toBe(50)
    expect(estimate.scrollOffsetPixels).toBe(30)
    expect(estimate.newPixels).toBe(30)
    expect(estimate.similarity).toBeCloseTo(1, 6)
    expect(estimate.reliable).toBe(true)
    expect(estimate.duplicate).toBe(false)
  })

  it('classifies a repeated frame as a duplicate before searching offsets', () => {
    const frame = sliceRows(createDocument(32, 80), 0, 80)
    expect(estimateVerticalOverlap(frame, frame)).toMatchObject({
      overlapPixels: 80,
      newPixels: 0,
      reliable: true,
      duplicate: true
    })
  })

  it('rejects visually unrelated frames instead of guessing a seam', () => {
    const estimate = estimateVerticalOverlap(
      solidFrame(40, 80, [245, 30, 30]),
      solidFrame(40, 80, [30, 80, 245]),
      { minOverlapPixels: 10 }
    )

    expect(estimate.reliable).toBe(false)
    expect(estimate.confidence).toBeLessThan(0.72)
  })

  it('marks periodic content as ambiguous even when several offsets match exactly', () => {
    const width = 32
    const height = 82
    const document = solidFrame(width, height + 4, [0, 0, 0])
    for (let y = 0; y < document.height; y += 1) {
      const value = y % 4 < 2 ? 24 : 230
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 4
        document.data[offset] = value
        document.data[offset + 1] = value
        document.data[offset + 2] = value
      }
    }

    const estimate = estimateVerticalOverlap(
      sliceRows(document, 0, height),
      sliceRows(document, 2, height),
      { minOverlapPixels: 10 }
    )

    expect(estimate.similarity).toBeCloseTo(1, 6)
    expect(estimate.secondBestSimilarity).toBeCloseTo(1, 6)
    expect(estimate.reliable).toBe(false)
  })
})

describe('static edge detection', () => {
  it('detects a fixed header and footer across scrolling frames', () => {
    const document = createDocument(40, 128)
    const makeViewport = (scrollTop: number): RawImage => {
      const header = solidFrame(40, 8, [15, 35, 55])
      const content = sliceRows(document, scrollTop, 64)
      const footer = solidFrame(40, 8, [220, 210, 180])
      return {
        data: Buffer.concat([
          Buffer.from(header.data),
          Buffer.from(content.data),
          Buffer.from(footer.data)
        ]),
        width: 40,
        height: 80,
        channels: 4
      }
    }

    expect(detectStableEdgeInsets([makeViewport(0), makeViewport(32), makeViewport(64)])).toEqual({
      top: 8,
      bottom: 8
    })
  })
})

describe('stitchScrollFrames', () => {
  it('stitches lossless frames without duplicate or missing rows', async () => {
    const document = createDocument(36, 160)
    const frames = await Promise.all(
      [0, 40, 80].map((start) => encodePng(sliceRows(document, start, 80)))
    )

    const result = await stitchScrollFrames(frames, {
      minOverlapPixels: 12,
      detectStaticEdges: false,
      sampleColumns: 36,
      sampleRows: 40
    })
    const decoded = await decodePng(result.buffer)

    expect(result).toMatchObject({
      width: 36,
      height: 160,
      frameCount: 3,
      uniqueFrameCount: 3,
      droppedDuplicateFrames: 0
    })
    expect(result.overlaps.map((overlap) => overlap.overlapPixels)).toEqual([40, 40])
    expect(Buffer.from(decoded.data)).toEqual(Buffer.from(document.data))
  })

  it('drops repeated frames and keeps the stitched height stable', async () => {
    const document = createDocument(32, 120)
    const first = await encodePng(sliceRows(document, 0, 80))
    const second = await encodePng(sliceRows(document, 40, 80))

    const result = await stitchScrollFrames([first, first, second], {
      minOverlapPixels: 12,
      detectStaticEdges: false
    })

    expect(result).toMatchObject({
      height: 120,
      frameCount: 3,
      uniqueFrameCount: 2,
      droppedDuplicateFrames: 1
    })
  })

  it('removes repeated sticky edges while preserving the first header and final footer', async () => {
    const document = createDocument(40, 96)
    const makeViewport = (scrollTop: number): RawImage => {
      const header = solidFrame(40, 8, [15, 35, 55])
      const content = sliceRows(document, scrollTop, 64)
      const footer = solidFrame(40, 8, [220, 210, 180])
      return {
        data: Buffer.concat([
          Buffer.from(header.data),
          Buffer.from(content.data),
          Buffer.from(footer.data)
        ]),
        width: 40,
        height: 80,
        channels: 4
      }
    }
    const frames = await Promise.all([0, 32].map((start) => encodePng(makeViewport(start))))

    const result = await stitchScrollFrames(frames, {
      minOverlapPixels: 12,
      minStaticEdgePixels: 8,
      sampleColumns: 40,
      sampleRows: 40
    })

    expect(result.staticInsets).toEqual({ top: 8, bottom: 8 })
    expect(result.overlaps[0].overlapPixels).toBe(40)
    expect(result.height).toBe(112)
  })

  it('fails closed when no reliable overlap can be established', async () => {
    const first = await encodePng(solidFrame(32, 80, [255, 0, 0]))
    const second = await encodePng(solidFrame(32, 80, [0, 0, 255]))

    await expect(
      stitchScrollFrames([first, second], { minOverlapPixels: 10, detectStaticEdges: false })
    ).rejects.toEqual(
      expect.objectContaining<Partial<ScrollStitchError>>({ code: 'UNRELIABLE_OVERLAP' })
    )
  })

  it('guards frame count, width and output dimensions before unsafe allocation', async () => {
    const frame = await encodePng(sliceRows(createDocument(24, 100), 0, 60))
    await expect(stitchScrollFrames([frame, frame], { maxFrames: 1 })).rejects.toEqual(
      expect.objectContaining<Partial<ScrollStitchError>>({ code: 'TOO_MANY_FRAMES' })
    )
    await expect(
      stitchScrollFrames([frame, frame], { maxTotalInputPixels: 2_000 })
    ).rejects.toEqual(
      expect.objectContaining<Partial<ScrollStitchError>>({ code: 'INPUT_TOO_LARGE' })
    )

    const wider = await encodePng(sliceRows(createDocument(25, 100), 40, 60))
    await expect(stitchScrollFrames([frame, wider])).rejects.toEqual(
      expect.objectContaining<Partial<ScrollStitchError>>({ code: 'WIDTH_MISMATCH' })
    )

    const document = createDocument(24, 100)
    const first = await encodePng(sliceRows(document, 0, 60))
    const second = await encodePng(sliceRows(document, 40, 60))
    await expect(
      stitchScrollFrames([first, second], {
        minOverlapPixels: 10,
        detectStaticEdges: false,
        maxOutputHeight: 90
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<ScrollStitchError>>({ code: 'OUTPUT_TOO_LARGE' })
    )
  })
})
