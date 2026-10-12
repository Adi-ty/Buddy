import { EventEmitter } from 'node:events'
export const app = { isPackaged: false }
export const screen = new EventEmitter()
export const powerMonitor = new EventEmitter()
screen.getAllDisplays = () => [
  {
    id: 1,
    bounds: { x: 0, y: 0, width: 1512, height: 982 },
    workArea: { x: 0, y: 38, width: 1512, height: 920 },
    scaleFactor: 2,
    rotation: 0,
  },
]
screen.cursor = { x: 0, y: 0 }
screen.getCursorScreenPoint = () => screen.cursor
export const globalShortcut = { register: () => true, unregister() {} }
export class Notification extends EventEmitter {
  show() {}
  close() {
    this.emit('close')
  }
}
export class BrowserWindow extends EventEmitter {
  constructor() {
    super()
    this.webContents = new EventEmitter()
    this.visible = false
    this.destroyed = false
    this.ignored = true
  }
  isDestroyed() {
    return this.destroyed
  }
  setBounds(bounds) {
    this.bounds = bounds
  }
  getBounds() {
    return this.bounds
  }
  setIgnoreMouseEvents(value) {
    this.ignored = value
  }
  showInactive() {
    this.visible = true
  }
  setFocusable(value) {
    this.focusable = value
  }
  focus() {
    this.focused = true
  }
  blur() {
    this.focused = false
  }
  hide() {
    this.visible = false
  }
  destroy() {
    this.destroyed = true
    this.visible = false
  }
}
