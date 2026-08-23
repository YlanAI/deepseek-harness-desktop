import { beforeEach, describe, expect, it, vi } from 'vitest'

const adapterOptions = vi.hoisted(() => ({ value: undefined as Record<string, unknown> | undefined }))
const registerAdapter = vi.hoisted(() => vi.fn(() => () => {}))

vi.mock('@deepseek-ai/dsh-llm-pi-ai', () => ({
  authContextFrom: vi.fn(() => ({})),
  credentialStoreFrom: vi.fn(() => ({})),
  resolveProfiles: vi.fn((profiles: unknown) => new Map(Object.entries(profiles as object))),
  PiAiAdapter: class {
    constructor(options: Record<string, unknown>) {
      adapterOptions.value = options
    }
  },
}))

import { apply } from '../src/local-llama.ts'

describe('local llama.cpp Provider', () => {
  beforeEach(() => {
    adapterOptions.value = undefined
    registerAdapter.mockClear()
  })

  it('registers a dedicated Provider and starts the runtime only when credentials are resolved', async () => {
    const ensureReady = vi.fn(async () => {})
    const snapshot = vi.fn(() => ({ contextSize: 8_192 }))
    const runtime = {
      baseURL: 'http://127.0.0.1:42001/v1',
      apiKey: 'private-runtime-key',
      activeModelName: () => 'model.gguf',
      snapshot,
      ensureReady,
    }
    const effect = vi.fn((factory: () => unknown) => factory())
    const ctx = {
      llm: { registerAdapter },
      effect,
      get: vi.fn((key: string) => key === 'desktopLocalLlama' ? runtime : undefined),
      logger: { warn: vi.fn() },
    }

    apply(ctx as never)

    expect(registerAdapter).toHaveBeenCalledWith(['local-llama'], expect.anything())
    expect(ensureReady).not.toHaveBeenCalled()
    const resolveApiKey = adapterOptions.value?.resolveApiKey as (() => Promise<string>) | undefined
    await expect(resolveApiKey?.()).resolves.toBe('private-runtime-key')
    expect(ensureReady).toHaveBeenCalledOnce()

    const profiles = adapterOptions.value?.profiles as (() => ReadonlyMap<string, unknown>) | undefined
    expect(profiles?.().get('local-llama')).toMatchObject({
      displayName: 'Local GGUF (llama.cpp)',
      api: 'openai-completions',
      baseURL: runtime.baseURL,
      models: [expect.objectContaining({ id: 'active-gguf', name: 'model.gguf' })],
    })
  })

  it('stays inert when loaded outside the Electron-owned Host', () => {
    const ctx = {
      llm: { registerAdapter },
      effect: vi.fn(),
      get: vi.fn(() => undefined),
      logger: { warn: vi.fn() },
    }

    apply(ctx as never)

    expect(registerAdapter).not.toHaveBeenCalled()
    expect(adapterOptions.value).toBeUndefined()
  })
})
