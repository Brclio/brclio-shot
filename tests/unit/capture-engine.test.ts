import { describe, expect, it, vi } from 'vitest'
import {
  CaptureEngine,
  CaptureEngineError,
  dipRectToPixelRect,
  type CaptureEngineDependencies,
  type DesktopSourceLike,
  type DisplayLike,
  type NativeImageLike,
  type PixelRect
} from '../../src/main/capture-engine'

interface ImageRecord {
  width: number
  height: number
  label: string
}

class FakeNativeImage implements NativeImageLike {
  constructor(
    readonly record: ImageRecord,
    private readonly cropLog: PixelRect[] = []
  ) {}

  crop(rect: PixelRect): NativeImageLike {
    this.cropLog.push({ ...rect })
    return new FakeNativeImage(
      { width: rect.width, height: rect.height, label: `${this.record.label}:crop` },
      this.cropLog
    )
  }

  getSize(): { width: number; height: number } {
    return { width: this.record.width, height: this.record.height }
  }

  isEmpty(): boolean {
    return this.record.width <= 0 || this.record.height <= 0
  }

  resize(options: { width?: number; height?: number }): NativeImageLike {
    return new FakeNativeImage(
      {
        width: options.width ?? this.record.width,
        height: options.height ?? this.record.height,
        label: `${this.record.label}:resize`
      },
      this.cropLog
    )
  }

  toDataURL(): string {
    return `data:image/fake,${this.record.label}`
  }

  toPNG(): Buffer {
    return Buffer.from(JSON.stringify(this.record))
  }
}

function decodeFakeImage(buffer: Buffer, cropLog: PixelRect[]): FakeNativeImage {
  return new FakeNativeImage(JSON.parse(buffer.toString()) as ImageRecord, cropLog)
}

function makeDependencies(options: {
  displays?: DisplayLike[]
  sources?: DesktopSourceLike[]
  activeDisplayId?: string | number
} = {}): {
  dependencies: CaptureEngineDependencies
  getSources: ReturnType<typeof vi.fn<CaptureEngineDependencies['desktopCapturer']['getSources']>>
  cropLog: PixelRect[]
} {
  const cropLog: PixelRect[] = []
  const displays =
    options.displays ??
    ([
      {
        id: 1,
        bounds: { x: 0, y: 0, width: 100, height: 80 },
        scaleFactor: 1
      }
    ] satisfies DisplayLike[])
  const sources =
    options.sources ??
    ([
      {
        id: 'screen:0:0',
        name: 'Primary screen',
        display_id: '1',
        thumbnail: new FakeNativeImage({ width: 100, height: 80, label: 'screen-1' }, cropLog)
      }
    ] satisfies DesktopSourceLike[])
  const getSources = vi.fn<CaptureEngineDependencies['desktopCapturer']['getSources']>(
    async ({ types }) =>
      sources.filter((source) =>
        types.includes(source.id.startsWith('screen:') ? 'screen' : 'window')
      )
  )
  const activeDisplay =
    displays.find((display) => String(display.id) === String(options.activeDisplayId)) ?? displays[0]

  return {
    dependencies: {
      desktopCapturer: { getSources },
      screen: {
        getAllDisplays: () => displays,
        getCursorScreenPoint: () => ({ x: activeDisplay.bounds.x + 1, y: activeDisplay.bounds.y + 1 }),
        getDisplayNearestPoint: () => activeDisplay
      },
      nativeImage: {
        createFromBuffer: (buffer) => decodeFakeImage(buffer, cropLog)
      }
    },
    getSources,
    cropLog
  }
}

describe('DIP and pixel coordinate conversion', () => {
  it('converts global negative display coordinates using the Retina scale factor', () => {
    expect(
      dipRectToPixelRect(
        { x: -1400, y: 10, width: 100, height: 50 },
        { x: -1440, y: 0, width: 1440, height: 900 },
        2,
        { width: 2880, height: 1800 }
      )
    ).toEqual({ x: 80, y: 20, width: 200, height: 100 })
  })

  it('clips a partially off-display selection without producing an invalid crop', () => {
    expect(
      dipRectToPixelRect(
        { x: -10, y: 70, width: 30, height: 20 },
        { x: 0, y: 0, width: 100, height: 80 },
        1.5,
        { width: 150, height: 120 }
      )
    ).toEqual({ x: 0, y: 105, width: 30, height: 15 })
  })
})

describe('CaptureEngine', () => {
  it('lists screen/window sources as serializable previews', async () => {
    const icon = new FakeNativeImage({ width: 32, height: 32, label: 'app-icon' })
    const { dependencies, getSources } = makeDependencies({
      sources: [
        {
          id: 'window:12:0',
          name: 'Notes',
          thumbnail: new FakeNativeImage({ width: 320, height: 200, label: 'notes' }),
          appIcon: icon
        }
      ]
    })

    const result = await new CaptureEngine(dependencies).listSources('window', {
      thumbnailSize: { width: 640, height: 360 }
    })

    expect(getSources).toHaveBeenCalledWith({
      types: ['window'],
      thumbnailSize: { width: 640, height: 360 },
      fetchWindowIcons: true
    })
    expect(result).toEqual([
      expect.objectContaining({
        id: 'window:12:0',
        name: 'Notes',
        kind: 'window',
        width: 320,
        height: 200,
        appIconDataUrl: 'data:image/fake,app-icon'
      })
    ])
  })

  it('captures the display underneath the cursor at its physical pixel size', async () => {
    const displays: DisplayLike[] = [
      { id: 1, bounds: { x: 0, y: 0, width: 120, height: 100 }, scaleFactor: 1 },
      { id: 2, bounds: { x: -100, y: -20, width: 100, height: 80 }, scaleFactor: 2 }
    ]
    const { dependencies, getSources } = makeDependencies({
      displays,
      activeDisplayId: 2,
      sources: [
        {
          id: 'screen:0:0',
          name: 'Primary',
          display_id: '1',
          thumbnail: new FakeNativeImage({ width: 120, height: 100, label: 'primary' })
        },
        {
          id: 'screen:1:0',
          name: 'Retina left',
          display_id: '2',
          thumbnail: new FakeNativeImage({ width: 200, height: 160, label: 'retina' })
        }
      ]
    })

    const result = await new CaptureEngine(dependencies).captureActiveDisplay()

    expect(getSources).toHaveBeenCalledWith({
      types: ['screen'],
      thumbnailSize: { width: 200, height: 160 },
      fetchWindowIcons: false
    })
    expect(result).toMatchObject({
      sourceId: 'screen:1:0',
      displayId: '2',
      width: 200,
      height: 160,
      scaleFactor: 2,
      boundsDip: { x: -100, y: -20, width: 100, height: 80 }
    })
  })

  it('captures a global DIP region on a negative-coordinate Retina display', async () => {
    const display: DisplayLike = {
      id: 9,
      bounds: { x: -100, y: -20, width: 100, height: 80 },
      scaleFactor: 2
    }
    const { dependencies, cropLog } = makeDependencies({
      displays: [display],
      sources: [
        {
          id: 'screen:0:0',
          name: 'Left Retina',
          display_id: '9',
          thumbnail: new FakeNativeImage({ width: 200, height: 160, label: 'left-retina' })
        }
      ]
    })

    const result = await new CaptureEngine(dependencies).captureRegion(
      { x: -90, y: -10, width: 20, height: 30 },
      { displayId: 9 }
    )

    expect(cropLog).toEqual([{ x: 20, y: 20, width: 40, height: 60 }])
    expect(result).toMatchObject({
      width: 40,
      height: 60,
      displayId: '9',
      boundsDip: { x: -90, y: -10, width: 20, height: 30 },
      clipped: false
    })
  })

  it('captures a window by source id without loading Electron in the test process', async () => {
    const { dependencies, getSources } = makeDependencies({
      sources: [
        {
          id: 'window:55:0',
          name: 'Browser',
          thumbnail: new FakeNativeImage({ width: 1440, height: 900, label: 'browser' })
        }
      ]
    })

    const result = await new CaptureEngine(dependencies).captureSource('window:55:0')

    expect(getSources).toHaveBeenCalledWith({
      types: ['window'],
      thumbnailSize: { width: 8192, height: 8192 },
      fetchWindowIcons: true
    })
    expect(result).toMatchObject({
      sourceId: 'window:55:0',
      kind: 'window',
      width: 1440,
      height: 900
    })
  })

  it('returns a structured error when a requested display is missing', async () => {
    const { dependencies } = makeDependencies()
    await expect(new CaptureEngine(dependencies).captureDisplay('missing')).rejects.toEqual(
      expect.objectContaining<Partial<CaptureEngineError>>({ code: 'DISPLAY_NOT_FOUND' })
    )
  })
})
