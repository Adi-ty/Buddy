import type { BuddyAPI } from '../../shared/contracts'

declare global {
  interface Window {
    buddy: BuddyAPI
  }
}
