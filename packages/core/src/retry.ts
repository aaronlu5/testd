import type { EnvironmentLimits, RetryPolicy } from '@test-platform/contracts';

export type EffectiveRetryPolicy = Required<RetryPolicy>;

export const DEFAULT_RETRY: EffectiveRetryPolicy = {
  maxAttempts: 1,
  initialDelayMs: 1_000,
  backoffMultiplier: 2,
  maxDelayMs: 30_000,
};

/** Merges node policy over defaults and clamps it to the environment limits. */
export const effectiveRetryPolicy = (
  policy?: RetryPolicy,
  limits?: EnvironmentLimits,
): EffectiveRetryPolicy => {
  const merged = { ...DEFAULT_RETRY, ...policy };
  if (limits?.maxRetryAttempts !== undefined) {
    merged.maxAttempts = Math.min(merged.maxAttempts, limits.maxRetryAttempts);
  }
  merged.maxDelayMs = Math.max(merged.maxDelayMs, 0);
  return merged;
};

/**
 * Delay before the retry that follows failed attempt `attempt` (1-based).
 * `random` (0..1) enables full jitter; omit it for deterministic delays.
 */
export const computeBackoffMs = (
  attempt: number,
  policy: EffectiveRetryPolicy,
  random?: () => number,
): number => {
  const exponent = Math.max(attempt - 1, 0);
  const raw = Math.min(
    policy.initialDelayMs * policy.backoffMultiplier ** exponent,
    policy.maxDelayMs,
  );
  const delay = random ? raw * random() : raw;
  return Math.round(Math.max(delay, 0));
};

export const shouldRetry = (
  attempt: number,
  policy: EffectiveRetryPolicy,
  retryable: boolean,
): boolean => retryable && attempt < policy.maxAttempts;
