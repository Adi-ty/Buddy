export interface TelegramPreferences {
  permissions: boolean
  questions: boolean
  completions: boolean
  failures: boolean
  paused: boolean
}
export interface TelegramStatus {
  state:
    | 'disconnected'
    | 'validating'
    | 'pairing'
    | 'connected'
    | 'offline'
    | 'suspended'
    | 'conflict'
    | 'error'
  message: string
  botUsername: string | null
  pairedUser: string | null
  deliveryProblem?: boolean
  preferences: TelegramPreferences
}
export interface TelegramPairing {
  url: string
  expiresAt: number
}
export const TELEGRAM_DEFAULTS: TelegramPreferences = {
  permissions: true,
  questions: true,
  completions: true,
  failures: true,
  paused: false,
}
