import { describe, expect, it, vi } from 'vitest'
import type { Monaco } from '@monaco-editor/react'
import { configureMonaco } from '../src/configureMonaco'

describe('configureMonaco', () => {
  it('enables JSX parsing in the TypeScript language service', () => {
    const setCompilerOptions = vi.fn()
    const compilerOptions = { target: 99 }
    const monaco = {
      languages: {
        typescript: {
          JsxEmit: { Preserve: 1 },
          typescriptDefaults: {
            getCompilerOptions: () => compilerOptions,
            setCompilerOptions,
          },
        },
      },
    } as unknown as Monaco

    configureMonaco(monaco)

    expect(setCompilerOptions).toHaveBeenCalledWith({ target: 99, jsx: 1 })
  })
})
