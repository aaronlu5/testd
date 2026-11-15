export const formatDuration = (ms: number | undefined): string => {
  if (ms === undefined) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 2 : 1)} s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes} min ${Math.round(seconds - minutes * 60)} s`
}

export const formatTime = (iso: string | undefined): string =>
  iso ? new Date(iso).toLocaleString() : '—'

/** Run duration from its timestamps, or time elapsed so far for an active Run. */
export const runDurationMs = (run: {
  startedAt?: string
  finishedAt?: string
}): number | undefined => {
  if (!run.startedAt) return undefined
  const end = run.finishedAt ? Date.parse(run.finishedAt) : Date.now()
  return Math.max(end - Date.parse(run.startedAt), 0)
}

/** Which part of the system a failure came from, so a tester knows where to look first. */
export const describeFailureOrigin = (code: string): string => {
  if (code === 'EXECUTION_ASSERTION_FAILED') return 'Assertion'
  if (code === 'EXECUTION_TRANSFORM_FAILED') return 'Transformation'
  if (code === 'EXECUTION_TIMEOUT' || code === 'TARGET_TIMEOUT') return 'Timeout'
  if (code === 'EXECUTION_CANCELLED') return 'Cancellation'
  if (code.startsWith('VALIDATION_')) return 'Test validation'
  if (code.startsWith('TARGET_')) return 'Target call'
  if (code.startsWith('AUTH_')) return 'Authentication'
  return 'Platform'
}

export const TRUNCATED_KEY = '$truncated'

export const truncationOf = (
  preview: unknown,
): { sizeBytes?: number; preview?: string } | undefined => {
  if (typeof preview !== 'object' || preview === null || Array.isArray(preview)) return undefined
  const record = preview as Record<string, unknown>
  if (record[TRUNCATED_KEY] !== true) return undefined
  return {
    sizeBytes: typeof record.sizeBytes === 'number' ? record.sizeBytes : undefined,
    preview: typeof record.preview === 'string' ? record.preview : undefined,
  }
}
