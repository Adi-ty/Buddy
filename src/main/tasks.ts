// Background callbacks must report a failure without taking down observation.
export function runTask(label: string, action: () => void, failed?: () => void): void {
  try {
    action()
  } catch (error) {
    console.error(`${label} failed`, error)
    try {
      failed?.()
    } catch (recoveryError) {
      console.error(`${label} recovery failed`, recoveryError)
    }
  }
}
