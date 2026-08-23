import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as LocalLlamaPlugin from '../src/local-llama.ts'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => { resolve() }))))
})

async function streamingServer(): Promise<{
  readonly baseURL: string
  readonly requests: Record<string, unknown>[]
}> {
  const requests: Record<string, unknown>[] = []
  const streams = [
    [
      { choices: [{ delta: { role: 'assistant' }, index: 0, finish_reason: null }] },
      { choices: [{ delta: { reasoning_content: 'brief thought' }, index: 0, finish_reason: null }] },
      { choices: [{ delta: { content: 'hello' }, index: 0, finish_reason: null }] },
      { choices: [{ delta: {}, index: 0, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 4 } },
      '[DONE]',
    ],
    [
      { choices: [{ delta: { role: 'assistant' }, index: 0, finish_reason: null }] },
      { choices: [{ delta: { content: 'plain answer' }, index: 0, finish_reason: null }] },
      { choices: [{ delta: {}, index: 0, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } },
      '[DONE]',
    ],
  ]
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    request.on('end', () => {
      requests.push(JSON.parse(body) as Record<string, unknown>)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const event of streams.shift() ?? []) {
        response.write(`data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`)
      }
      response.end()
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('local test server did not bind')
  return { baseURL: `http://127.0.0.1:${String(address.port)}/v1`, requests }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('local llama.cpp streaming Provider', () => {
  it('uses the shared API streaming pipeline and maps per-request thinking controls', async () => {
    const server = await streamingServer()
    const ensureReady = vi.fn(async () => {})
    const runtime = {
      baseURL: server.baseURL,
      apiKey: 'private-runtime-key',
      activeModelName: () => 'model.gguf',
      snapshot: () => ({ contextSize: 32_768 }),
      ensureReady,
    }
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    ctx.provide('desktopLocalLlama', runtime as never)
    await ctx.plugin(LocalLlamaPlugin)
    const message = createUserMessage({
      content: [{ type: 'text', text: 'hello' }],
      source: { kind: 'plugin', plugin: 'local-llama-test' },
    })

    const thinking = await collect(ctx.llm.stream({
      provider: 'local-llama',
      model: 'active-gguf',
      reasoningEffort: ReasoningEffortId('medium'),
      messages: [message],
    }))
    const plain = await collect(ctx.llm.stream({
      provider: 'local-llama',
      model: 'active-gguf',
      reasoningEffort: ReasoningEffortId('off'),
      messages: [message],
    }))

    expect(thinking).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'reasoning-delta', text: 'brief thought' }),
      expect.objectContaining({ type: 'text-delta', text: 'hello' }),
      expect.objectContaining({ type: 'finish', reason: { kind: 'stop' } }),
    ]))
    expect(plain).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text-delta', text: 'plain answer' }),
      expect.objectContaining({ type: 'finish', reason: { kind: 'stop' } }),
    ]))
    expect(server.requests).toHaveLength(2)
    expect(server.requests[0]).toMatchObject({
      stream: true,
      chat_template_kwargs: {
        enable_thinking: true,
        reasoning_effort: 'medium',
        preserve_thinking: true,
      },
    })
    expect(server.requests[1]).toMatchObject({
      stream: true,
      chat_template_kwargs: {
        enable_thinking: false,
        preserve_thinking: true,
      },
    })
    expect((server.requests[1]?.chat_template_kwargs as Record<string, unknown>)).not.toHaveProperty('reasoning_effort')
    expect(ensureReady).toHaveBeenCalledTimes(2)

    await ctx.fiber.dispose()
  })
})
