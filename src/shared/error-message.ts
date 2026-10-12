// Electron wraps rejected invoke() calls with internal channel names. Keep
// the actionable main-process message when presenting it to the user.
export function errorMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return (
    message
      .replace(/^(?:Error invoking remote method ['"][^'"]+['"]:\s*)+/, '')
      .replace(/^Error:\s*/, '')
      .trim() || fallback
  )
}
