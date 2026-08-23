/** Desktop-owned Local Provider backed by the launcher-managed llama-server. */

import type { Context } from '@deepseek-ai/cordis'
import {
  authContextFrom,
  credentialStoreFrom,
  PiAiAdapter,
  resolveProfiles,
} from '@deepseek-ai/dsh-llm-pi-ai'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import {
  LOCAL_LLAMA_MODEL,
  LOCAL_LLAMA_PROVIDER,
  type LocalLlamaRuntime,
} from './local-llama-runtime.ts'

export const name = 'desktop-local-llama'
export const inject = ['llm']

function profiles(runtime: LocalLlamaRuntime): ReadonlyMap<string, ResolvedPiAiProviderProfile> {
  const snapshot = runtime.snapshot()
  return resolveProfiles({
    [LOCAL_LLAMA_PROVIDER]: {
      displayName: 'Local GGUF (llama.cpp)',
      api: 'openai-completions',
      baseURL: runtime.baseURL,
      defaultContextWindow: snapshot.contextSize,
      defaultMaxTokens: Math.min(32_768, Math.max(512, Math.floor(snapshot.contextSize / 2))),
      models: [{
        id: LOCAL_LLAMA_MODEL,
        name: runtime.activeModelName() ?? 'Select a local GGUF model',
        contextWindow: snapshot.contextSize,
        maxTokens: Math.min(32_768, Math.max(512, Math.floor(snapshot.contextSize / 2))),
        input: ['text'],
      }],
      retryPolicy: { mode: 'normal', maxRetries: 1 },
      streamIdleTimeoutMs: 10 * 60_000,
    },
  })
}

/** Register the stable local route; the active GGUF is resolved per request. */
export function apply(ctx: Context): void {
  const runtime = ctx.get('desktopLocalLlama')
  if (runtime === undefined) return
  const llm = ctx.llm
  let cachedFacts = ''
  let cachedProfiles: ReadonlyMap<string, ResolvedPiAiProviderProfile> | undefined
  const currentProfiles = (): ReadonlyMap<string, ResolvedPiAiProviderProfile> => {
    const snapshot = runtime.snapshot()
    const facts = JSON.stringify({
      model: runtime.activeModelName(),
      contextSize: snapshot.contextSize,
      baseURL: runtime.baseURL,
    })
    if (cachedProfiles === undefined || facts !== cachedFacts) {
      cachedProfiles = profiles(runtime)
      cachedFacts = facts
    }
    return cachedProfiles
  }
  const adapter = new PiAiAdapter({
    profiles: currentProfiles,
    resolveApiKey: async () => {
      await runtime.ensureReady()
      return runtime.apiKey
    },
    auth: {
      credentials: credentialStoreFrom(ctx),
      authContext: authContextFrom(ctx),
    },
    resolveAttachments: () => ctx.get('attachments'),
    onReplayDegrade: detail => {
      ctx.logger.warn(
        `desktop-local-llama: replay metadata degraded for ${detail.provider}/${detail.model} (${detail.reason})`,
      )
    },
  })
  ctx.effect(
    () => llm.registerAdapter([LOCAL_LLAMA_PROVIDER], adapter),
    'dsh-plugin-desktop: local llama.cpp Provider',
  )
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Launcher-owned local GGUF registry and inference process. */
    desktopLocalLlama: LocalLlamaRuntime
  }
}
