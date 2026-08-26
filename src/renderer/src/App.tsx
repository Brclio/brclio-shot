import { CaptureOverlay, CaptureRuntime, PinWindow, ScrollController } from './components/SpecialViews'
import Workspace from './components/Workspace'

function currentRoute(): string {
  return window.location.hash.replace(/^#\/?/, '').split('?')[0]
}

export default function App(): React.JSX.Element {
  switch (currentRoute()) {
    case 'overlay':
      return <CaptureOverlay />
    case 'scroll-controller':
      return <ScrollController />
    case 'pin':
      return <PinWindow />
    case 'capture-runtime':
      return <CaptureRuntime />
    default:
      return <Workspace />
  }
}
