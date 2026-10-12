/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_LOCAL_FIXTURE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
