import { describe, expect, it, vi } from 'vitest'
import type { Monaco } from '@monaco-editor/react'
import { configureMonaco } from '../src/configureMonaco'

describe('configureMonaco', () => {
  it('enables JSX parsing in the TypeScript language service', () => {
    const setCompilerOptions = vi.fn()
    const addExtraLib = vi.fn()
    const compilerOptions = { target: 99 }
    const monaco = {
      languages: {
        typescript: {
          JsxEmit: { Preserve: 1 },
          typescriptDefaults: {
            getCompilerOptions: () => compilerOptions,
            setCompilerOptions,
            addExtraLib,
          },
        },
      },
    } as unknown as Monaco

    configureMonaco(monaco)

    expect(setCompilerOptions).toHaveBeenCalledWith({ target: 99, jsx: 1 })
    expect(addExtraLib).toHaveBeenCalledWith(
      'declare module "tscircuit" { export type ChipProps = Record<string, unknown> }',
      'file:///node_modules/tscircuit/index.d.ts',
    )
  })
})
