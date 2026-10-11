export const DASHBOARD_ROUTES = [
  '/sessions',
  '/history',
  '/integrations',
  '/overlay-preview',
] as const
export type DashboardRoute = (typeof DASHBOARD_ROUTES)[number]

export type HarnessId = 'codex' | 'claude-code' | 'opencode'

export interface HarnessCatalogEntry {
  id: HarnessId
  name: string
  shortLabel: string
  description: string
  connection: 'not-connected'
  installation: 'not-checked'
}

export interface AvatarPreview {
  harness: HarnessId
  dataUri: string
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface OverlayDisplay {
  id: number
  uuid: string | null
  name: string
  builtIn: boolean
  bounds: Rect
  workArea: Rect
  scaleFactor: number
  safeTop: number
  camera: Rect | null
  auxiliaryLeft: Rect | null
  auxiliaryRight: Rect | null
}

export const PREVIEW_MODES = ['idle', 'running', 'overflow', 'attention'] as const
export type PreviewMode = (typeof PREVIEW_MODES)[number]
export interface OverlayPreviewOptions {
  mode: PreviewMode
  displayId: number | null
  clickThrough: boolean
}

export interface PreviewSession extends AvatarPreview {
  id: string
  name: string
  project: string
  status: 'working' | 'waiting' | 'needs-attention'
}

export interface OverlayState extends OverlayPreviewOptions {
  geometry: 'loading' | 'ready' | 'unavailable' | 'suspended'
  message: string | null
  displays: readonly OverlayDisplay[]
  anchorId: number | null
  expanded: boolean
  visible: boolean
  actualBounds: Rect | null
  shortcutAvailable: boolean
  previewSessions: readonly PreviewSession[]
}

// No provider has been observed at bootstrap. Empty arrays are not a claim of
// zero provider sessions: coverage is explicitly unavailable until connected.
export interface BuddySnapshot {
  revision: number
  coverage: 'not-connected'
  sessions: readonly never[]
  history: readonly never[]
  harnesses: readonly HarnessCatalogEntry[]
  avatarPreviews: readonly AvatarPreview[]
  overlay: OverlayState
  runtime: {
    appVersion: string
    electron: string
    chromium: string
    node: string
    platform: string
    architecture: string
    packaged: boolean
    overlayPreviewEnabled: boolean
  }
}

export interface BuddyAPI {
  getSnapshot(): Promise<BuddySnapshot>
  onSnapshot(listener: (snapshot: BuddySnapshot) => void): () => void
  onNavigate(listener: (route: DashboardRoute) => void): () => void
  setOverlayPreview(options: OverlayPreviewOptions): Promise<void>
  refreshDisplays(): Promise<void>
  setOverlayExpanded(expanded: boolean): Promise<void>
  openDashboard(): Promise<void>
}

export const IPC = {
  snapshot: 'buddy:get-snapshot',
  navigate: 'buddy:navigate',
  navigationReady: 'buddy:navigation-ready',
  updated: 'buddy:snapshot-updated',
  overlayPreview: 'buddy:overlay-preview',
  refreshDisplays: 'buddy:refresh-displays',
  overlayExpanded: 'buddy:overlay-expanded',
  openDashboard: 'buddy:open-dashboard',
} as const
