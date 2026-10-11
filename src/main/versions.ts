const versionPattern = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?`

export function parseCliVersion(output: string): string | null {
  return output.match(new RegExp(`\\b${versionPattern}\\b`))?.[0] ?? null
}

export function isCliVersion(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 120 &&
    new RegExp(`^${versionPattern}$`).test(value)
  )
}
