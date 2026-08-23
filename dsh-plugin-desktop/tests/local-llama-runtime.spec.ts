import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesktopLogger } from '../src/desktop-logger.ts'
import {
  LocalLlamaRuntime,
  localLlamaRuntimeDirectory,
} from '../src/local-llama-runtime.ts'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-local-llama-'))
  temporaryDirectories.push(root)
  const runtimeDir = join(root, 'runtime')
  const privateDir = join(root, 'private')
  const statePath = join(root, 'state.json')
  const modelPath = join(root, 'outside-model.gguf')
  writeFileSync(modelPath, 'gguf')
  return { root, runtimeDir, privateDir, statePath, modelPath }
}

function logger(): DesktopLogger {
  return { error: vi.fn(), errorCause: vi.fn() }
}

function fakeChild() {
  const child = new EventEmitter() as ChildProcess
  Object.assign(child, {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => {
      queueMicrotask(() => { child.emit('close', 0, null) })
      return true
    }),
  })
  return child
}

describe('local llama.cpp runtime', () => {
  it('persists external GGUF references without projecting their paths', async () => {
    const paths = fixture()
    const runtime = new LocalLlamaRuntime({
      platform: 'win32',
      runtimeDir: paths.runtimeDir,
      statePath: paths.statePath,
      privateDir: paths.privateDir,
      port: 42_001,
      logger: logger(),
    })

    const view = await runtime.add(paths.modelPath)
    expect(view).toMatchObject({ contextSize: 32_768, gpuLayers: 99, speculativeDecoding: false })
    expect(view.models).toEqual([
      expect.objectContaining({ name: 'outside-model.gguf', size: 4, selected: true }),
    ])
    expect(JSON.stringify(view)).not.toContain(paths.modelPath)
    const persisted = JSON.parse(readFileSync(paths.statePath, 'utf8')) as {
      models: Array<{ path: string }>
    }
    expect(persisted.models[0]?.path).toBe(paths.modelPath)

    const restored = new LocalLlamaRuntime({
      platform: 'win32',
      runtimeDir: paths.runtimeDir,
      statePath: paths.statePath,
      privateDir: paths.privateDir,
      port: 42_002,
      logger: logger(),
    })
    expect(restored.snapshot()).toEqual(view)

    await restored.remove(view.models[0]!.id)
    expect(existsSync(paths.modelPath)).toBe(true)
    expect(restored.snapshot().models).toEqual([])
  })

  it('starts the pinned server with loopback authentication and stops it cleanly', async () => {
    const paths = fixture()
    mkdirSync(paths.runtimeDir, { recursive: true })
    writeFileSync(join(paths.runtimeDir, 'llama-server.exe'), '')
    const child = fakeChild()
    const calls: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = []
    const runtime = new LocalLlamaRuntime({
      platform: 'win32',
      runtimeDir: paths.runtimeDir,
      statePath: paths.statePath,
      privateDir: paths.privateDir,
      port: 42_003,
      logger: logger(),
      spawn: (command, args, options) => {
        calls.push({ command, args, options })
        return child
      },
      fetch: vi.fn(async () => new Response('ok')),
    })
    await runtime.add(paths.modelPath)
    await runtime.configure({ contextSize: 32_768, gpuLayers: 99, speculativeDecoding: true })

    await expect(runtime.start()).resolves.toMatchObject({ status: 'ready' })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.command).toBe(join(paths.runtimeDir, 'llama-server.exe'))
    expect(calls[0]?.args).toEqual([
      '--model', paths.modelPath,
      '--host', '127.0.0.1',
      '--port', '42003',
      '--ctx-size', '32768',
      '--n-gpu-layers', '99',
      '--api-key-file', join(paths.privateDir, 'api-key.txt'),
      '--jinja',
      '--no-webui',
      '--spec-type', 'draft-mtp',
      '--spec-draft-n-max', '2',
    ])
    expect(calls[0]?.options).toMatchObject({ shell: false, windowsHide: true })
    expect(readFileSync(join(paths.privateDir, 'api-key.txt'), 'utf8').trim()).toBe(runtime.apiKey)

    await expect(runtime.stop()).resolves.toMatchObject({ status: 'stopped' })
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    await runtime.dispose()
    expect(existsSync(join(paths.privateDir, 'api-key.txt'))).toBe(false)
  })

  it.each([
    [8_192, 32_768],
    [16_384, 16_384],
  ])('migrates v1 context %i to %i without losing the registry', (storedContext, expectedContext) => {
    const paths = fixture()
    writeFileSync(paths.statePath, `${JSON.stringify({
      version: 1,
      models: [{ id: 'model-1', path: paths.modelPath, name: 'outside-model.gguf', size: 4 }],
      selectedModelId: 'model-1',
      contextSize: storedContext,
      gpuLayers: 42,
      speculativeDecoding: true,
    })}\n`)

    const runtime = new LocalLlamaRuntime({
      platform: 'win32',
      runtimeDir: paths.runtimeDir,
      statePath: paths.statePath,
      privateDir: paths.privateDir,
      port: 42_006,
      logger: logger(),
    })

    expect(runtime.snapshot()).toMatchObject({
      contextSize: expectedContext,
      gpuLayers: 42,
      speculativeDecoding: true,
      selectedModelId: 'model-1',
      models: [expect.objectContaining({ name: 'outside-model.gguf', selected: true })],
    })
    expect(JSON.parse(readFileSync(paths.statePath, 'utf8'))).toMatchObject({
      version: 2,
      contextSize: expectedContext,
    })
  })

  it('reports unsupported platforms and resolves development and packaged locations', async () => {
    const paths = fixture()
    const runtime = new LocalLlamaRuntime({
      platform: 'linux',
      runtimeDir: paths.runtimeDir,
      statePath: paths.statePath,
      privateDir: paths.privateDir,
      port: 42_004,
      logger: logger(),
    })
    expect(runtime.snapshot()).toMatchObject({ available: false, status: 'unavailable' })
    await expect(runtime.add(paths.modelPath)).rejects.toThrow('available on Windows only')
    expect(localLlamaRuntimeDirectory(true, 'C:\\resources', 'file:///ignored.js', undefined))
      .toBe(join('C:\\resources', 'llama', 'windows-x64'))
    expect(localLlamaRuntimeDirectory(false, 'ignored', 'file:///C:/repo/dsh-plugin-desktop/lib/main.js', undefined))
      .toBe('C:\\repo\\.build\\llama\\windows-x64')
  })

  it('converts synchronous process creation failures into a stable error state', async () => {
    const paths = fixture()
    mkdirSync(paths.runtimeDir, { recursive: true })
    writeFileSync(join(paths.runtimeDir, 'llama-server.exe'), '')
    const runtime = new LocalLlamaRuntime({
      platform: 'win32',
      runtimeDir: paths.runtimeDir,
      statePath: paths.statePath,
      privateDir: paths.privateDir,
      port: 42_005,
      logger: logger(),
      spawn: () => { throw new Error(`private native failure at ${paths.runtimeDir}`) },
    })
    await runtime.add(paths.modelPath)

    await expect(runtime.start()).rejects.toThrow('llama-server could not be started')
    expect(runtime.snapshot()).toMatchObject({
      status: 'error',
      detail: 'llama-server could not be started.',
    })
    expect(JSON.stringify(runtime.snapshot())).not.toContain(paths.runtimeDir)
  })
})
