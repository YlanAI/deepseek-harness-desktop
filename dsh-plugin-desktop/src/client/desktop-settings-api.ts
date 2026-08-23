/** Same-origin browser client for launcher-owned Desktop settings operations. */

const SETTINGS_PATH = '/api/desktop/settings'
const PROFILE_CREATE_PATH = '/api/desktop/profiles/create'
const PROFILE_SELECT_PATH = '/api/desktop/profiles/select'
const PROFILE_DELETE_PATH = '/api/desktop/profiles/delete'
const MARKET_SELECT_PATH = '/api/desktop/market/select'
const TERMINAL_OPEN_PATH = '/api/desktop/terminal/open'
const LOCAL_MODEL_ADD_PATH = '/api/desktop/local-models/add'
const LOCAL_MODEL_SELECT_PATH = '/api/desktop/local-models/select'
const LOCAL_MODEL_REMOVE_PATH = '/api/desktop/local-models/remove'
const LOCAL_MODEL_CONFIGURE_PATH = '/api/desktop/local-models/configure'
const LOCAL_MODEL_START_PATH = '/api/desktop/local-models/start'
const LOCAL_MODEL_STOP_PATH = '/api/desktop/local-models/stop'
const MAX_PROFILES = 256
const MAX_PROFILE_NAME_LENGTH = 255

/** Launcher-supported plugin market implementations. */
export type DesktopMarketProvider = 'disabled' | 'community-market' | 'dsh-market'

/** Safe profile projection returned to the renderer. */
export interface DesktopProfileView {
  readonly name: string
  readonly exists: boolean
  readonly webCapable: boolean
  readonly selectable: boolean
  readonly deletable: boolean
}

/** Market selection fixed for the running generation. */
export interface DesktopMarketView {
  readonly requested: DesktopMarketProvider
  readonly effective: DesktopMarketProvider
  readonly legacyDefaulted: boolean
}

/** Complete launcher-owned settings projection. */
export interface DesktopSettingsView {
  readonly current: string
  readonly profiles: readonly DesktopProfileView[]
  readonly market: DesktopMarketView
  readonly localLlama: LocalLlamaView
}

export type LocalLlamaStatus = 'unavailable' | 'stopped' | 'starting' | 'ready' | 'stopping' | 'error'

export interface LocalLlamaModelView {
  readonly id: string
  readonly name: string
  readonly size: number
  readonly selected: boolean
}

export interface LocalLlamaView {
  readonly available: boolean
  readonly status: LocalLlamaStatus
  readonly detail?: string
  readonly models: readonly LocalLlamaModelView[]
  readonly selectedModelId?: string
  readonly contextSize: number
  readonly gpuLayers: number
  readonly speculativeDecoding: boolean
}

export interface LocalLlamaConfiguration {
  readonly contextSize: number
  readonly gpuLayers: number
  readonly speculativeDecoding: boolean
}

/** A persisted selection that requires a new Desktop generation. */
export interface DesktopRestartAcceptance {
  readonly accepted: true
  readonly restartRequired: boolean
}

/** Browser operations consumed by the Desktop settings section. */
export interface DesktopSettingsApi {
  read(): Promise<DesktopSettingsView>
  createProfile(name: string): Promise<DesktopSettingsView>
  selectProfile(name: string): Promise<DesktopRestartAcceptance>
  deleteProfile(name: string): Promise<DesktopSettingsView>
  selectMarket(provider: DesktopMarketProvider): Promise<DesktopRestartAcceptance>
  addLocalModel(): Promise<LocalLlamaView>
  selectLocalModel(id: string): Promise<LocalLlamaView>
  removeLocalModel(id: string): Promise<LocalLlamaView>
  configureLocalModel(config: LocalLlamaConfiguration): Promise<LocalLlamaView>
  startLocalModel(): Promise<LocalLlamaView>
  stopLocalModel(): Promise<LocalLlamaView>
  openTerminal(): Promise<void>
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isMarketProvider(value: unknown): value is DesktopMarketProvider {
  return value === 'disabled' || value === 'community-market' || value === 'dsh-market'
}

function parseProfile(value: unknown): DesktopProfileView {
  if (!isObject(value)
    || typeof value.name !== 'string'
    || value.name.length === 0
    || value.name.length > MAX_PROFILE_NAME_LENGTH
    || typeof value.exists !== 'boolean'
    || typeof value.webCapable !== 'boolean'
    || typeof value.selectable !== 'boolean'
    || typeof value.deletable !== 'boolean') {
    throw new Error('dsh-plugin-desktop: invalid profile settings response')
  }
  return Object.freeze({
    name: value.name,
    exists: value.exists,
    webCapable: value.webCapable,
    selectable: value.selectable,
    deletable: value.deletable,
  })
}

function parseLocalLlama(value: unknown): LocalLlamaView {
  if (!isObject(value)
    || typeof value.available !== 'boolean'
    || !['unavailable', 'stopped', 'starting', 'ready', 'stopping', 'error'].includes(String(value.status))
    || (value.detail !== undefined && typeof value.detail !== 'string')
    || !Array.isArray(value.models)
    || value.models.length > 256
    || (value.selectedModelId !== undefined && typeof value.selectedModelId !== 'string')
    || !Number.isSafeInteger(value.contextSize)
    || !Number.isSafeInteger(value.gpuLayers)
    || typeof value.speculativeDecoding !== 'boolean') {
    throw new Error('dsh-plugin-desktop: invalid local llama.cpp settings response')
  }
  const models = value.models.map((candidate): LocalLlamaModelView => {
    if (!isObject(candidate)
      || typeof candidate.id !== 'string' || candidate.id.length === 0 || candidate.id.length > 128
      || typeof candidate.name !== 'string' || candidate.name.length === 0 || candidate.name.length > 512
      || !Number.isSafeInteger(candidate.size) || Number(candidate.size) < 1
      || typeof candidate.selected !== 'boolean') {
      throw new Error('dsh-plugin-desktop: invalid local model settings response')
    }
    return Object.freeze({
      id: candidate.id,
      name: candidate.name,
      size: candidate.size as number,
      selected: candidate.selected,
    })
  })
  if (new Set(models.map(model => model.id)).size !== models.length
    || models.filter(model => model.selected).length > 1
    || (value.selectedModelId !== undefined
      && !models.some(model => model.id === value.selectedModelId && model.selected))) {
    throw new Error('dsh-plugin-desktop: inconsistent local model settings response')
  }
  return Object.freeze({
    available: value.available,
    status: value.status as LocalLlamaStatus,
    ...(value.detail === undefined ? {} : { detail: value.detail as string }),
    models: Object.freeze(models),
    ...(value.selectedModelId === undefined ? {} : { selectedModelId: value.selectedModelId as string }),
    contextSize: value.contextSize as number,
    gpuLayers: value.gpuLayers as number,
    speculativeDecoding: value.speculativeDecoding,
  })
}

/** Validate the bounded settings projection before it reaches React state. */
export function parseDesktopSettingsView(value: unknown): DesktopSettingsView {
  if (!isObject(value)
    || typeof value.current !== 'string'
    || value.current.length === 0
    || value.current.length > MAX_PROFILE_NAME_LENGTH
    || !Array.isArray(value.profiles)
    || value.profiles.length > MAX_PROFILES
    || !isObject(value.market)
    || !isObject(value.localLlama)
    || !isMarketProvider(value.market.requested)
    || !isMarketProvider(value.market.effective)
    || typeof value.market.legacyDefaulted !== 'boolean') {
    throw new Error('dsh-plugin-desktop: invalid Desktop settings response')
  }
  const profiles = value.profiles.map(parseProfile)
  if (new Set(profiles.map(profile => profile.name)).size !== profiles.length) {
    throw new Error('dsh-plugin-desktop: duplicate profile in settings response')
  }
  return Object.freeze({
    current: value.current,
    profiles: Object.freeze(profiles),
    market: Object.freeze({
      requested: value.market.requested,
      effective: value.market.effective,
      legacyDefaulted: value.market.legacyDefaulted,
    }),
    localLlama: parseLocalLlama(value.localLlama),
  })
}

/** Validate restart acknowledgement returned before the Host generation exits. */
export function parseDesktopRestartAcceptance(value: unknown): DesktopRestartAcceptance {
  if (!isObject(value) || value.accepted !== true || typeof value.restartRequired !== 'boolean') {
    throw new Error('dsh-plugin-desktop: invalid Desktop restart response')
  }
  return Object.freeze({ accepted: true, restartRequired: value.restartRequired })
}

/** Validate the exact acknowledgement returned by a Desktop side effect. */
export function parseDesktopActionAcceptance(value: unknown): void {
  if (!isObject(value)
    || Object.keys(value).length !== 1
    || value.accepted !== true) {
    throw new Error('dsh-plugin-desktop: invalid Desktop action response')
  }
}

async function readResponse(response: Response): Promise<unknown> {
  if (!response.ok) {
    throw new Error(`dsh-plugin-desktop: Desktop settings request failed (${String(response.status)})`)
  }
  try {
    return await response.json() as unknown
  } catch {
    throw new Error('dsh-plugin-desktop: Desktop settings response was not JSON')
  }
}

function post(fetcher: FetchLike, path: string, body: object): Promise<Response> {
  return fetcher(path, {
    method: 'POST',
    credentials: 'same-origin',
    redirect: 'error',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

/** Construct the default same-origin API, with a fetch seam for focused tests. */
export function createDesktopSettingsApi(fetcher: FetchLike = globalThis.fetch.bind(globalThis)): DesktopSettingsApi {
  return Object.freeze({
    async read() {
      const response = await fetcher(SETTINGS_PATH, {
        method: 'GET',
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
        headers: { 'Accept': 'application/json' },
      })
      return parseDesktopSettingsView(await readResponse(response))
    },
    async createProfile(name: string) {
      return parseDesktopSettingsView(await readResponse(await post(fetcher, PROFILE_CREATE_PATH, { name })))
    },
    async selectProfile(name: string) {
      return parseDesktopRestartAcceptance(await readResponse(await post(fetcher, PROFILE_SELECT_PATH, { name })))
    },
    async deleteProfile(name: string) {
      return parseDesktopSettingsView(await readResponse(await post(fetcher, PROFILE_DELETE_PATH, { name })))
    },
    async selectMarket(provider: DesktopMarketProvider) {
      return parseDesktopRestartAcceptance(await readResponse(await post(fetcher, MARKET_SELECT_PATH, { provider })))
    },
    async addLocalModel() {
      return parseLocalLlama(await readResponse(await post(fetcher, LOCAL_MODEL_ADD_PATH, {})))
    },
    async selectLocalModel(id: string) {
      return parseLocalLlama(await readResponse(await post(fetcher, LOCAL_MODEL_SELECT_PATH, { id })))
    },
    async removeLocalModel(id: string) {
      return parseLocalLlama(await readResponse(await post(fetcher, LOCAL_MODEL_REMOVE_PATH, { id })))
    },
    async configureLocalModel(config: LocalLlamaConfiguration) {
      return parseLocalLlama(await readResponse(await post(fetcher, LOCAL_MODEL_CONFIGURE_PATH, config)))
    },
    async startLocalModel() {
      return parseLocalLlama(await readResponse(await post(fetcher, LOCAL_MODEL_START_PATH, {})))
    },
    async stopLocalModel() {
      return parseLocalLlama(await readResponse(await post(fetcher, LOCAL_MODEL_STOP_PATH, {})))
    },
    async openTerminal() {
      parseDesktopActionAcceptance(await readResponse(await post(fetcher, TERMINAL_OPEN_PATH, {})))
    },
  })
}

export const desktopSettingsPaths = Object.freeze({
  settings: SETTINGS_PATH,
  profileCreate: PROFILE_CREATE_PATH,
  profileSelect: PROFILE_SELECT_PATH,
  profileDelete: PROFILE_DELETE_PATH,
  marketSelect: MARKET_SELECT_PATH,
  terminalOpen: TERMINAL_OPEN_PATH,
  localModelAdd: LOCAL_MODEL_ADD_PATH,
  localModelSelect: LOCAL_MODEL_SELECT_PATH,
  localModelRemove: LOCAL_MODEL_REMOVE_PATH,
  localModelConfigure: LOCAL_MODEL_CONFIGURE_PATH,
  localModelStart: LOCAL_MODEL_START_PATH,
  localModelStop: LOCAL_MODEL_STOP_PATH,
})
