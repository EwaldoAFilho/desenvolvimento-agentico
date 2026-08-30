export const INTEGRATION_STATUSES = ['MERGED', 'CONFLICT', 'SKIPPED'] as const
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number]

export interface CommitRef {
  readonly sha: string
  readonly branch?: string
  readonly message?: string
}

export interface IntegrationResult {
  readonly status: IntegrationStatus
  readonly commit?: CommitRef
  readonly conflicts?: readonly string[]
  readonly detail?: string
}
