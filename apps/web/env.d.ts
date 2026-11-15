/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the control-plane API. Must not contain credentials. */
  readonly VITE_API_BASE_URL?: string
  /** Non-secret label shown in the environment indicator. */
  readonly VITE_ENVIRONMENT_LABEL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
