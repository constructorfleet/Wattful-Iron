import type { Monaco } from '@monaco-editor/react'

export function configureMonaco(monaco: Monaco) {
  monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
    ...monaco.languages.typescript.typescriptDefaults.getCompilerOptions(),
    jsx: monaco.languages.typescript.JsxEmit.ReactJSX,
  })
}
