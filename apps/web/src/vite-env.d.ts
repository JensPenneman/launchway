/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** `1` serves the whole API from MSW mock handlers (`src/mocks`), for demos and e2e tests. */
  readonly VITE_API_MOCK?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
