import type { Monaco } from '@monaco-editor/react'

export function configureMonaco(monaco: Monaco) {
  monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
    ...monaco.languages.typescript.typescriptDefaults.getCompilerOptions(),
    // The server compiles tscircuit JSX. Preserve syntax in Monaco so its
    // editor-only language service does not try to resolve react/jsx-runtime.
    jsx: monaco.languages.typescript.JsxEmit.Preserve,
  })
}
