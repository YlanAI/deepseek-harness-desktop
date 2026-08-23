/** Launcher-owned local GGUF registry and llama-server process lifetime. */

import { spawn as childSpawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type { DesktopLogger } from './desktop-logger.ts'

const BIN_NAME = 'dsh-plugin-desktop'
const STATE_VERSION = 2
const LEGACY_DEFAULT_CONTEXT_SIZE = 8_192
const DEFAULT_CONTEXT_SIZE = 32_768
const DEFAULT_GPU_LAYERS = 99
const DEFAULT_STARTUP_TIMEOUT_MS = 10 * 60_000
const HEALTH_POLL_MS = 500
const STOP_TIMEOUT_MS = 5_000
const MAX_CAPTURE_BYTES = 64 * 1024

export const LOCAL_LLAMA_PROVIDER = 'local-llama'
export const LOCAL_LLAMA_MODEL = 'active-gguf'

export type LocalLlamaStatus = 'unavailable' | 'stopped' | 'starting' | 'ready' | 'stopping' | 'error'

export interface LocalLlamaModelView {
  readonly id: string
  readonly name: string
  readonly size: number
  readonly selected: boolean
}

export interface LocalLlamaSettingsView {
  readonly available: boolean
  readonly status: LocalLlamaStatus
  readonly detail?: string
  readonly models: readonly LocalLlamaModelView[]
  readonly selectedModelId?: string
  readonly contextSize: number
  readonly gpuLayers: number
  readonly speculativeDecoding: boolean
}

interface LocalLlamaModelRecord {
  readonly id: string
  readonly path: string
  readonly name: string
  readonly size: number
}

interface LocalLlamaState {
  readonly version: 2
  readonly models: readonly LocalLlamaModelRecord[]
  readonly selectedModelId?: string
  readonly contextSize: number
  readonly gpuLayers: number
  readonly speculativeDecoding: boolean
}

interface StoredLocalLlamaState {
  readonly version?: unknown
  readonly models?: unknown
  readonly selectedModelId?: unknown
  readonly contextSize?: unknown
  readonly gpuLayers?: unknown
  readonly speculativeDecoding?: unknown
}

export interface LocalLlamaConfiguration {
  readonly contextSize: number
  readonly gpuLayers: number
  readonly speculativeDecoding: boolean
}

export interface LocalLlamaRuntimeOptions {
  readonly platform: NodeJS.Platform
  readonly runtimeDir: string
  readonly statePath: string
  readonly privateDir: string
  readonly port: number
  readonly logger: DesktopLogger
  readonly startupTimeoutMs?: number
  readonly spawn?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess
  readonly fetch?: typeof globalThis.fetch
}

function defaultState(): LocalLlamaState {
  return Object.freeze({
    version: STATE_VERSION,
    models: Object.freeze([]),
    contextSize: DEFAULT_CONTEXT_SIZE,
    gpuLayers: DEFAULT_GPU_LAYERS,
    speculativeDecoding: false,
  })
}

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum
}

function modelRecord(value: unknown): LocalLlamaModelRecord | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Partial<LocalLlamaModelRecord>
  if (typeof record.id !== 'string' || record.id.length === 0 || record.id.length > 128
    || typeof record.path !== 'string' || !isAbsolute(record.path) || record.path.includes('\0')
    || typeof record.name !== 'string' || record.name.length === 0 || record.name.length > 512
    || !integer(record.size, 1, Number.MAX_SAFE_INTEGER)) return undefined
  return Object.freeze({ id: record.id, path: record.path, name: record.name, size: record.size })
}

function parseState(value: unknown): LocalLlamaState {
  if (value === null || typeof value !== 'object') return defaultState()
  const record = value as StoredLocalLlamaState
  if ((record.version !== 1 && record.version !== STATE_VERSION) || !Array.isArray(record.models)
    || !integer(record.contextSize, 512, 262_144)
    || !integer(record.gpuLayers, 0, 999)
    || typeof record.speculativeDecoding !== 'boolean') return defaultState()
  const models = record.models.map(modelRecord)
  if (models.some(model => model === undefined)) return defaultState()
  const complete = models as LocalLlamaModelRecord[]
  if (new Set(complete.map(model => model.id)).size !== complete.length
    || new Set(complete.map(model => model.path.toLowerCase())).size !== complete.length) return defaultState()
  const selectedModelId = typeof record.selectedModelId === 'string'
    && complete.some(model => model.id === record.selectedModelId)
    ? record.selectedModelId
    : undefined
  return Object.freeze({
    version: STATE_VERSION,
    models: Object.freeze(complete),
    ...(selectedModelId === undefined ? {} : { selectedModelId }),
    contextSize: record.version === 1 && record.contextSize === LEGACY_DEFAULT_CONTEXT_SIZE
      ? DEFAULT_CONTEXT_SIZE
      : record.contextSize,
    gpuLayers: record.gpuLayers,
    speculativeDecoding: record.speculativeDecoding,
  })
}

function readState(path: string): LocalLlamaState {
  try {
    const source = JSON.parse(readFileSync(path, 'utf8')) as { readonly version?: unknown }
    const state = parseState(source)
    if (source.version !== STATE_VERSION) writeState(path, state)
    return state
  } catch {
    return defaultState()
  }
}

function writeState(path: string, state: LocalLlamaState): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${String(process.pid)}.tmp`
  writeFileSync(temporary, `${JSON.stringify(state, undefined, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, path)
}

function appendCapture(current: string, chunk: Buffer | string): string {
  const next = `${current}${Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk}`
  return Buffer.byteLength(next) <= MAX_CAPTURE_BYTES
    ? next
    : Buffer.from(next).subarray(-MAX_CAPTURE_BYTES).toString('utf8')
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveDelay, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const finish = (): void => {
      signal?.removeEventListener('abort', abort)
      resolveDelay()
    }
    const timer = setTimeout(finish, ms)
    const abort = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

/** Acquire a currently-unused loopback TCP port for one launcher generation. */
export async function chooseLocalLlamaPort(): Promise<number> {
  return await new Promise<number>((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new Error(`${BIN_NAME}: failed to allocate local llama.cpp port`))
        return
      }
      server.close(error => error === undefined ? resolvePort(address.port) : reject(error))
    })
  })
}

/** Resolve the development or packaged Windows runtime directory. */
export function localLlamaRuntimeDirectory(
  packaged: boolean,
  resourcesPath: string,
  moduleUrl: string = import.meta.url,
  override: string | undefined = process.env.DSH_LLAMA_SERVER_PATH,
): string {
  if (override !== undefined && override.length > 0) {
    const absolute = resolve(override)
    return extname(absolute).toLowerCase() === '.exe' ? dirname(absolute) : absolute
  }
  if (packaged) return join(resourcesPath, 'llama', 'windows-x64')
  return resolve(dirname(fileURLToPath(moduleUrl)), '..', '..', '.build', 'llama', 'windows-x64')
}

/** One Electron-generation owner for local model references and llama-server. */
export class LocalLlamaRuntime {
  readonly baseURL: string
  readonly apiKey: string

  private state: LocalLlamaState
  private status: LocalLlamaStatus
  private detail: string | undefined
  private child: ChildProcess | undefined
  private startTask: Promise<void> | undefined
  private stopTask: Promise<void> | undefined
  private stderr = ''
  private disposed = false

  constructor(private readonly options: LocalLlamaRuntimeOptions) {
    this.baseURL = `http://127.0.0.1:${String(options.port)}/v1`
    this.apiKey = randomBytes(32).toString('base64url')
    this.state = readState(options.statePath)
    this.status = options.platform === 'win32' ? 'stopped' : 'unavailable'
  }

  /** Renderer-safe current registry and process status. */
  snapshot(): LocalLlamaSettingsView {
    return Object.freeze({
      available: this.options.platform === 'win32',
      status: this.status,
      ...(this.detail === undefined ? {} : { detail: this.detail }),
      models: Object.freeze(this.state.models.map(model => Object.freeze({
        id: model.id,
        name: model.name,
        size: model.size,
        selected: model.id === this.state.selectedModelId,
      }))),
      ...(this.state.selectedModelId === undefined ? {} : { selectedModelId: this.state.selectedModelId }),
      contextSize: this.state.contextSize,
      gpuLayers: this.state.gpuLayers,
      speculativeDecoding: this.state.speculativeDecoding,
    })
  }

  /** Display name of the active GGUF without exposing its path. */
  activeModelName(): string | undefined {
    return this.selectedModel()?.name
  }

  /** Register an external GGUF and make it active. */
  async add(path: string): Promise<LocalLlamaSettingsView> {
    this.assertAvailable()
    if (!isAbsolute(path) || path.includes('\0') || extname(path).toLowerCase() !== '.gguf') {
      throw new Error(`${BIN_NAME}: local model must be an absolute .gguf file`)
    }
    const real = realpathSync(path)
    const stats = statSync(real)
    if (!stats.isFile() || stats.size < 1) throw new Error(`${BIN_NAME}: local model is not a readable file`)
    const existing = this.state.models.find(model => model.path.toLowerCase() === real.toLowerCase())
    const model: LocalLlamaModelRecord = existing ?? Object.freeze({
      id: randomUUID(),
      path: real,
      name: basename(real),
      size: stats.size,
    })
    const models = existing === undefined ? [...this.state.models, model] : [...this.state.models]
    await this.stop()
    this.replaceState({ ...this.state, models, selectedModelId: model.id })
    return this.snapshot()
  }

  /** Select a registered model and stop a process serving the previous one. */
  async select(id: string): Promise<LocalLlamaSettingsView> {
    this.assertAvailable()
    if (!this.state.models.some(model => model.id === id)) throw new Error(`${BIN_NAME}: unknown local model`)
    if (this.state.selectedModelId !== id) {
      await this.stop()
      this.replaceState({ ...this.state, selectedModelId: id })
    }
    return this.snapshot()
  }

  /** Remove a registry reference without deleting the external GGUF. */
  async remove(id: string): Promise<LocalLlamaSettingsView> {
    this.assertAvailable()
    const models = this.state.models.filter(model => model.id !== id)
    if (models.length === this.state.models.length) throw new Error(`${BIN_NAME}: unknown local model`)
    if (this.state.selectedModelId === id) await this.stop()
    const selectedModelId = this.state.selectedModelId === id ? models[0]?.id : this.state.selectedModelId
    const { selectedModelId: _previousSelection, ...withoutSelection } = this.state
    this.replaceState({
      ...withoutSelection,
      models,
      ...(selectedModelId === undefined ? {} : { selectedModelId }),
    })
    return this.snapshot()
  }

  /** Persist validated inference settings and stop a now-stale process. */
  async configure(config: LocalLlamaConfiguration): Promise<LocalLlamaSettingsView> {
    this.assertAvailable()
    if (!integer(config.contextSize, 512, 262_144)
      || !integer(config.gpuLayers, 0, 999)
      || typeof config.speculativeDecoding !== 'boolean') {
      throw new Error(`${BIN_NAME}: invalid local llama.cpp configuration`)
    }
    const changed = config.contextSize !== this.state.contextSize
      || config.gpuLayers !== this.state.gpuLayers
      || config.speculativeDecoding !== this.state.speculativeDecoding
    if (changed) await this.stop()
    this.replaceState({ ...this.state, ...config })
    return this.snapshot()
  }

  /** Start the selected model and wait until llama-server is healthy. */
  async start(signal?: AbortSignal): Promise<LocalLlamaSettingsView> {
    await this.ensureReady(signal)
    return this.snapshot()
  }

  /** Lazily ensure the selected model is serving for a Provider request. */
  async ensureReady(signal?: AbortSignal): Promise<void> {
    this.assertAvailable()
    if (this.disposed) throw new Error(`${BIN_NAME}: local llama.cpp runtime is disposed`)
    if (this.status === 'ready' && this.child !== undefined) return
    this.startTask ??= this.startProcess(signal).finally(() => { this.startTask = undefined })
    await this.startTask
  }

  /** Stop the current local inference process. */
  async stop(): Promise<LocalLlamaSettingsView> {
    this.stopTask ??= this.stopProcess().finally(() => { this.stopTask = undefined })
    await this.stopTask
    return this.snapshot()
  }

  /** Idempotently release process and private authentication material. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.stop()
    rmSync(join(this.options.privateDir, 'api-key.txt'), { force: true })
  }

  private async startProcess(signal?: AbortSignal): Promise<void> {
    if (this.status === 'ready') return
    const model = this.selectedModel()
    if (model === undefined) throw this.fail('Select a GGUF model before loading the local Provider.')
    if (!existsSync(model.path)) throw this.fail(`The selected GGUF file is no longer available: ${model.name}`)
    const executable = join(this.options.runtimeDir, 'llama-server.exe')
    if (!existsSync(executable)) throw this.fail('The packaged llama.cpp Runtime is unavailable.')
    await this.stopProcess()
    this.status = 'starting'
    this.detail = undefined
    this.stderr = ''
    mkdirSync(this.options.privateDir, { recursive: true })
    const keyPath = join(this.options.privateDir, 'api-key.txt')
    writeFileSync(keyPath, `${this.apiKey}\n`, { encoding: 'utf8', mode: 0o600 })
    const args = [
      '--model', model.path,
      '--host', '127.0.0.1',
      '--port', String(this.options.port),
      '--ctx-size', String(this.state.contextSize),
      '--n-gpu-layers', String(this.state.gpuLayers),
      '--api-key-file', keyPath,
      '--jinja',
      '--no-webui',
      ...(this.state.speculativeDecoding
        ? ['--spec-type', 'draft-mtp', '--spec-draft-n-max', '2']
        : []),
    ]
    const spawn = this.options.spawn ?? childSpawn
    let child: ChildProcess
    try {
      child = spawn(executable, args, {
        cwd: this.options.runtimeDir,
        env: { ...scrubbedParentEnv(), LLAMA_CACHE: this.options.privateDir },
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch {
      throw this.fail('llama-server could not be started.')
    }
    this.child = child
    child.stdout?.on('data', chunk => { this.stderr = appendCapture(this.stderr, chunk) })
    child.stderr?.on('data', chunk => { this.stderr = appendCapture(this.stderr, chunk) })
    child.once('error', () => {
      if (this.child !== child) return
      this.child = undefined
      this.status = 'error'
      this.detail = 'llama-server could not be started.'
    })
    child.once('close', (code, childSignal) => {
      if (this.child !== child) return
      this.child = undefined
      if (this.status === 'stopping' || this.disposed) {
        this.status = this.options.platform === 'win32' ? 'stopped' : 'unavailable'
        return
      }
      this.status = 'error'
      this.detail = `llama-server exited before it was stopped (code ${String(code)}, signal ${String(childSignal)}).`
      this.options.logger.error(`${BIN_NAME}: ${this.detail}`)
    })
    try {
      await this.waitUntilHealthy(child, signal)
      if (this.child !== child) throw new Error(`${BIN_NAME}: llama-server exited during startup`)
      this.status = 'ready'
      this.detail = undefined
    } catch (cause) {
      await this.stopProcess()
      const message = cause instanceof Error ? cause.message : String(cause)
      throw this.fail(message.includes(model.path) ? message.replaceAll(model.path, model.name) : message)
    }
  }

  private async waitUntilHealthy(child: ChildProcess, signal?: AbortSignal): Promise<void> {
    const timeout = AbortSignal.timeout(this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS)
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    const fetcher = this.options.fetch ?? globalThis.fetch
    while (!combined.aborted) {
      if (this.child !== child) throw new Error(`${BIN_NAME}: llama-server exited during model loading`)
      try {
        const response = await fetcher(`${this.baseURL.slice(0, -3)}/health`, {
          headers: { authorization: `Bearer ${this.apiKey}` },
          signal: AbortSignal.timeout(2_000),
        })
        if (response.ok) return
      } catch {
        // Connection refusal and 503 are expected while the model is loading.
      }
      await delay(HEALTH_POLL_MS, combined)
    }
    throw new Error(`${BIN_NAME}: llama-server model loading timed out`)
  }

  private async stopProcess(): Promise<void> {
    const child = this.child
    if (child === undefined) {
      if (this.status !== 'unavailable' && this.status !== 'error') this.status = 'stopped'
      return
    }
    this.status = 'stopping'
    this.child = undefined
    await new Promise<void>(resolveStop => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolveStop()
      }
      child.once('close', finish)
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* The process already exited. */ }
        finish()
      }, STOP_TIMEOUT_MS)
      timer.unref()
      try {
        if (!child.kill('SIGTERM')) finish()
      } catch {
        finish()
      }
    })
    this.status = this.options.platform === 'win32' ? 'stopped' : 'unavailable'
    this.detail = undefined
  }

  private selectedModel(): LocalLlamaModelRecord | undefined {
    return this.state.models.find(model => model.id === this.state.selectedModelId)
  }

  private replaceState(next: Omit<LocalLlamaState, 'version'> & { readonly version?: 2 }): void {
    const normalized = parseState({ ...next, version: STATE_VERSION })
    writeState(this.options.statePath, normalized)
    this.state = normalized
    if (this.status === 'error') {
      this.status = 'stopped'
      this.detail = undefined
    }
  }

  private fail(message: string): Error {
    this.status = 'error'
    this.detail = message.startsWith(`${BIN_NAME}: `) ? message.slice(BIN_NAME.length + 2) : message
    this.options.logger.error(`${BIN_NAME}: local llama.cpp: ${this.detail}`)
    return new Error(`${BIN_NAME}: local llama.cpp: ${this.detail}`)
  }

  private assertAvailable(): void {
    if (this.options.platform !== 'win32') throw new Error(`${BIN_NAME}: local llama.cpp is available on Windows only`)
  }
}
