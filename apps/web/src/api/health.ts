import { apiRequest, type ApiRequestOptions } from '~/api/client'

export type ReadinessResponse = {
  status: string
  [check: string]: unknown
}

// Health endpoints live outside the /api/v1 prefix.
export const getReadiness = (options?: ApiRequestOptions) =>
  apiRequest<ReadinessResponse>('/health/ready', options)
