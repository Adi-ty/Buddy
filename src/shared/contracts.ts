export const DASHBOARD_ROUTES = ['/sessions', '/history', '/integrations', '/settings'] as const
export type DashboardRoute = (typeof DASHBOARD_ROUTES)[number]
export const SESSION_ACTIONS = ['reveal', 'copyPath', 'copyId'] as const
export type SessionAction = (typeof SESSION_ACTIONS)[number]

import type { HarnessId } from './harnesses'
export type { HarnessId } from './harnesses'

export interface HarnessCatalogEntry {
  id: HarnessId
  name: string
  shortLabel: string
  description: string
  connection: 'not-connected' | 'configured' | 'observed' | 'stale'
  installation: 'not-checked' | 'installed' | 'not-found'
  observer: 'not-installed' | 'installed' | 'incomplete'
  controls?: boolean
  controlsConnection?: 'disabled' | 'connecting' | 'connected' | 'unavailable'
  controlsMessage?: string
  version?: string
  canInstall?: boolean
  setup?: string
  variants?: string
  installNotice?: string
  removeNotice?: string
  compatibility?: 'verified' | 'unverified' | 'unsupported'
  canInstallUnverified?: boolean
  configurationError?: string
  lastEventAt?: number
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

export interface OverlayOptions {
  displayId: number | null
}

export interface OverlayState extends OverlayOptions {
  geometry: 'loading' | 'ready' | 'unavailable' | 'suspended'
  message: string | null
  displays: readonly OverlayDisplay[]
  anchorId: number | null
  expanded: boolean
  visible: boolean
  actualBounds: Rect | null
  shortcutAvailable: boolean
  // Expired completion rows retained only during an existing hover/input.
  completionHoldIds?: readonly string[]
}

// No provider has been observed at bootstrap. Empty arrays are not a claim of
// zero provider sessions: coverage is explicitly unavailable until connected.
export type SessionStatus =
  | 'working'
  | 'idle'
  | 'completed'
  | 'needs-attention'
  | 'error'
  | 'interrupted'
  | 'unknown'
export interface SessionActivity {
  event: string
  at: number
  tool: string | null
}
export interface SessionRecord extends AvatarPreview {
  id: string
  providerSessionId: string
  source: 'hooks' | 'plugin' | 'app-server'
  client: 'unknown'
  name: string
  project: string
  cwd: string | null
  parentId: string | null
  status: SessionStatus
  statusChangedAt: number
  presence: 'observed' | 'stale' | 'closed'
  firstSeen: number
  lastSeen: number
  ordinal: number
  turnId: string | null
  turnStartedAt?: number
  // A confirmed runtime state, separate from the retained turn outcome.
  turnActive?: boolean
  attention: readonly { id: string; tool: string | null; kind: 'permission' | 'question' }[]
  activity: readonly SessionActivity[]
}

export interface BuddySnapshot {
  revision: number
  coverage: 'not-connected' | 'partial'
  sessions: readonly SessionRecord[]
  history: readonly SessionRecord[]
  requests?: readonly AgentRequest[]
  tracking: {
    available: boolean
    phase: 'starting' | 'running' | 'paused' | 'unavailable'
    message: string | null
    droppedObservations?: number
    capacityEvictions?: number
  }
  harnesses: readonly HarnessCatalogEntry[]
  avatarPreviews: readonly AvatarPreview[]
  overlay: OverlayState
  preferences?: { desktopNotifications: boolean; launchAtLogin: boolean; canLaunchAtLogin: boolean }
  runtime: {
    appVersion: string
    electron: string
    chromium: string
    node: string
    platform: string
    architecture: string
    packaged: boolean
  }
}

export interface BuddyAPI {
  getSnapshot(): Promise<BuddySnapshot>
  onSnapshot(listener: (snapshot: BuddySnapshot) => void): () => void
  onNavigate(listener: (route: DashboardRoute) => void): () => void
  setOverlayOptions(options: OverlayOptions): Promise<void>
  refreshDisplays(): Promise<void>
  setOverlayExpanded(expanded: boolean): Promise<void>
  openDashboard(): Promise<void>
  installIntegration(harness: HarnessId, allowUnverified?: boolean): Promise<void>
  removeIntegration(harness: HarnessId): Promise<void>
  refreshIntegrations(): Promise<void>
  sessionAction(id: string, action: SessionAction): Promise<void>
  getSessionAvatar(id: string): Promise<string>
  setPreference(key: 'desktopNotifications' | 'launchAtLogin', enabled: boolean): Promise<void>
  clearHistory(): Promise<void>
  setIntegrationControls(harness: HarnessId, enabled: boolean): Promise<void>
  respondToRequest(id: string, response: AgentResponse): Promise<void>
  setOverlayInput(enabled: boolean): Promise<void>
}

export interface AgentQuestion {
  text: string
  header: string
  multiple: boolean
  custom: boolean
  options: readonly { label: string; description: string }[]
}
export interface AgentRequest {
  id: string
  sessionId: string
  harness: HarnessId
  kind: 'permission' | 'question'
  tool: string | null
  details: string
  questions: readonly AgentQuestion[]
  createdAt: number
  expiresAt: number
  submitting: boolean
  error: string | null
  allowedDecisions?: readonly ('allow' | 'reject')[]
  allowLabel?: string
  mirrored?: boolean
}
export type AgentResponse =
  | { decision: 'allow' | 'reject' | 'native' }
  | { answers: readonly (readonly string[])[] }

export const IPC = {
  snapshot: 'buddy:get-snapshot',
  navigate: 'buddy:navigate',
  navigationReady: 'buddy:navigation-ready',
  updated: 'buddy:snapshot-updated',
  overlayOptions: 'buddy:overlay-options',
  refreshDisplays: 'buddy:refresh-displays',
  overlayExpanded: 'buddy:overlay-expanded',
  openDashboard: 'buddy:open-dashboard',
  installIntegration: 'buddy:install-integration',
  removeIntegration: 'buddy:remove-integration',
  refreshIntegrations: 'buddy:refresh-integrations',
  sessionAction: 'buddy:session-action',
  sessionAvatar: 'buddy:session-avatar',
  preference: 'buddy:preference',
  clearHistory: 'buddy:clear-history',
  integrationControls: 'buddy:integration-controls',
  respondToRequest: 'buddy:respond-to-request',
  overlayInput: 'buddy:overlay-input',
} as const
