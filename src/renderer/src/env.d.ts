/// <reference types="vite/client" />

import type { BrclioShotApi, CaptureRuntimeApi } from '../../shared/types'

declare global {
  interface Window {
    brclioShot: BrclioShotApi
    brclioRuntime: CaptureRuntimeApi
  }
}

export {}
