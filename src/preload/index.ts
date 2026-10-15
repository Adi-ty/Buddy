import { contextBridge, ipcRenderer } from 'electron'
import { DASHBOARD_ROUTES, IPC } from '../shared/contracts'
import type { BuddyAPI, DashboardRoute } from '../shared/contracts'

const api: BuddyAPI = {
  connectTelegram: (token) => ipcRenderer.invoke(IPC.telegramConnect, token),
  pairTelegram: () => ipcRenderer.invoke(IPC.telegramPair),
  copyTelegramPairingLink: (url) => ipcRenderer.invoke(IPC.telegramCopyPairingLink, url),
  disconnectTelegram: () => ipcRenderer.invoke(IPC.telegramDisconnect),
  reconnectTelegram: () => ipcRenderer.invoke(IPC.telegramReconnect),
  setTelegramPreferences: (preferences) => ipcRenderer.invoke(IPC.telegramPreferences, preferences),
  getSnapshot: () => ipcRenderer.invoke(IPC.snapshot),
  onSnapshot: (listener) => {
    const handle = (
      _event: Electron.IpcRendererEvent,
      snapshot: Parameters<typeof listener>[0],
    ): void => listener(snapshot)
    ipcRenderer.on(IPC.updated, handle)
    return () => ipcRenderer.removeListener(IPC.updated, handle)
  },
  moveCompanion: (action) => ipcRenderer.invoke(IPC.moveCompanion, action),
  resetCompanionPosition: () => ipcRenderer.invoke(IPC.resetCompanionPosition),
  setOverlayExpanded: (expanded) => ipcRenderer.invoke(IPC.overlayExpanded, expanded),
  openDashboard: () => ipcRenderer.invoke(IPC.openDashboard),
  installIntegration: (harness, allowUnverified = false) =>
    ipcRenderer.invoke(IPC.installIntegration, harness, allowUnverified),
  removeIntegration: (harness) => ipcRenderer.invoke(IPC.removeIntegration, harness),
  refreshIntegrations: () => ipcRenderer.invoke(IPC.refreshIntegrations),
  chooseExecutable: (harness, reset = false) =>
    ipcRenderer.invoke(IPC.chooseExecutable, harness, reset),
  sessionAction: (id, action) => ipcRenderer.invoke(IPC.sessionAction, id, action),
  getSessionAvatar: (id) => ipcRenderer.invoke(IPC.sessionAvatar, id),
  setPreference: (key, enabled) => ipcRenderer.invoke(IPC.preference, key, enabled),
  clearHistory: () => ipcRenderer.invoke(IPC.clearHistory),
  setIntegrationControls: (harness, enabled) =>
    ipcRenderer.invoke(IPC.integrationControls, harness, enabled),
  respondToRequest: (id, response) => ipcRenderer.invoke(IPC.respondToRequest, id, response),
  setOverlayInput: (enabled) => ipcRenderer.invoke(IPC.overlayInput, enabled),
  onNavigate: (listener) => {
    const handleNavigate = (_event: Electron.IpcRendererEvent, route: unknown): void => {
      if (typeof route === 'string' && DASHBOARD_ROUTES.some((allowed) => allowed === route)) {
        listener(route as DashboardRoute)
      }
    }
    ipcRenderer.on(IPC.navigate, handleNavigate)
    ipcRenderer.send(IPC.navigationReady)
    return () => ipcRenderer.removeListener(IPC.navigate, handleNavigate)
  },
}

contextBridge.exposeInMainWorld('buddy', api)
