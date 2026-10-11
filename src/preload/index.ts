import { contextBridge, ipcRenderer } from 'electron'
import { DASHBOARD_ROUTES, IPC } from '../shared/contracts'
import type { BuddyAPI, DashboardRoute } from '../shared/contracts'

const api: BuddyAPI = {
  getSnapshot: () => ipcRenderer.invoke(IPC.snapshot),
  onSnapshot: (listener) => {
    const handle = (
      _event: Electron.IpcRendererEvent,
      snapshot: Parameters<typeof listener>[0],
    ): void => listener(snapshot)
    ipcRenderer.on(IPC.updated, handle)
    return () => ipcRenderer.removeListener(IPC.updated, handle)
  },
  setOverlayPreview: (options) => ipcRenderer.invoke(IPC.overlayPreview, options),
  refreshDisplays: () => ipcRenderer.invoke(IPC.refreshDisplays),
  setOverlayExpanded: (expanded) => ipcRenderer.invoke(IPC.overlayExpanded, expanded),
  openDashboard: () => ipcRenderer.invoke(IPC.openDashboard),
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
