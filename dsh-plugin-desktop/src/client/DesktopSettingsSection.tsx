/** Desktop-owned settings section registered into the official Settings shell. */

import {
  useCallback, useEffect, useId, useState, useSyncExternalStore, type FormEvent, type ReactNode,
} from 'react'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  DesktopMarketProvider, DesktopProfileView, DesktopSettingsApi, DesktopSettingsView, LocalLlamaView,
} from './desktop-settings-api.ts'
import { FolderPlus, Play, Square, Trash2 } from 'lucide-react'
import type { DesktopSettingsLocaleKey } from './desktop-settings-locales.ts'
import type { DesktopClientPlatform } from './environment.ts'

/** Browser view of the Host `dsh-desktop` settings namespace. */
export interface DesktopShellSettings {
  readonly mode: 'compatibility' | 'advanced'
  readonly port: number
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error'
}

/** Browser view of the Host `dsh-desktop-notifications` settings namespace. */
export interface DesktopNotificationSettings {
  readonly enabled: boolean
  readonly notifyOnTurnCompletion: boolean
  readonly notifyOnTurnFailure: boolean
  readonly notifyOnJobCompletion: boolean
  readonly notifyOnJobFailure: boolean
}

/** Registration-side business face for the Desktop settings section. */
export interface DesktopSettingsSectionInjected {
  readonly api: DesktopSettingsApi
  readonly platform: DesktopClientPlatform
  readonly initialMode: DesktopShellSettings['mode']
  readonly desktopSettings: SettingsScope<DesktopShellSettings>
  readonly notificationSettings: SettingsScope<DesktopNotificationSettings>
}

/** Renderer-composed props for the official settings section entry. */
export type DesktopSettingsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'desktop.settings'>
  & InjectFace<DesktopSettingsSectionInjected>

type Translate = DesktopSettingsSectionProps['t']
type BusyOperation = 'load' | 'create-profile' | 'select-profile' | 'delete-profile' | 'select-market' | 'mode' | 'notification'
  | 'add-model' | 'select-model' | 'remove-model' | 'configure-model' | 'start-model' | 'stop-model'
type RestartState = 'none' | 'restarting' | 'required'

function useScope<T>(scope: SettingsScope<T>) {
  const subscribe = useCallback((listener: () => void) => scope.subscribe(listener), [scope])
  const snapshot = useCallback(() => scope.getSnapshot(), [scope])
  return useSyncExternalStore(subscribe, snapshot)
}

function Choice({
  title,
  body,
  aside,
  selected,
  reselectable,
  disabled,
  action,
  status,
}: {
  title: ReactNode
  body: ReactNode
  aside?: ReactNode
  selected: boolean
  reselectable?: boolean
  disabled?: boolean
  action: () => void
  status?: ReactNode
}) {
  const actionable = disabled !== true && (!selected || reselectable === true)
  const choose = (): void => {
    if (actionable) action()
  }
  return (
    <div
      role="radio"
      className="dshDesktopSettingsChoice"
      data-selected={selected ? 'true' : undefined}
      data-actionable={actionable ? 'true' : undefined}
      aria-checked={selected}
      aria-disabled={disabled === true ? 'true' : undefined}
      tabIndex={disabled === true ? -1 : 0}
      onClick={choose}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return
        event.preventDefault()
        choose()
      }}
    >
      <span className="dshDesktopSettingsChoiceCopy">
        <span className="dshDesktopSettingsChoiceTitle">
          {title}
          {status !== undefined && <span className="dshDesktopSettingsBadge">{status}</span>}
        </span>
        <span className="dshDesktopSettingsChoiceBody">{body}</span>
      </span>
      {aside}
    </div>
  )
}

function RepositoryLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      className="dshDesktopSettingsChoiceLink"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={event => { event.stopPropagation() }}
    >
      {children}
    </a>
  )
}

function ToggleRow({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: ReactNode
  checked: boolean
  disabled: boolean
  onChange: (checked: boolean) => void
}) {
  const labelId = useId()
  return (
    <div className="dshDesktopSettingsToggleRow">
      <span id={labelId}>{label}</span>
      <button
        type="button"
        role="switch"
        className="dshDesktopSettingsToggle"
        aria-checked={checked}
        aria-labelledby={labelId}
        disabled={disabled}
        onClick={() => { onChange(!checked) }}
      >
        <span className="dshDesktopSettingsToggleKnob" aria-hidden="true" />
      </button>
    </div>
  )
}

function profileState(profile: DesktopProfileView, t: Translate): string {
  if (!profile.webCapable || !profile.selectable) return t('profileUnavailable')
  return profile.exists ? t('profileReady') : t('profileMissing')
}

function formatModelSize(bytes: number): string {
  return `${(bytes / (1024 ** 3)).toFixed(1)} GB`
}

const MARKET_OPTIONS: readonly {
  id: DesktopMarketProvider
  title: DesktopSettingsLocaleKey
  body: DesktopSettingsLocaleKey
}[] = [
  { id: 'disabled', title: 'marketDisabled', body: 'marketDisabledBody' },
  { id: 'community-market', title: 'communityMarket', body: 'communityMarketBody' },
  { id: 'dsh-market', title: 'dshMarket', body: 'dshMarketBody' },
]

const COMMUNITY_MARKET_URL = 'https://github.com/anywhere-labs/deepseek-harness-desktop/tree/master/dsh-community-market'
const DSH_MARKET_URL = 'https://github.com/dsh-market/dsh-market'
const AWESOME_DSH_PLUGIN_URL = 'https://github.com/awesome-dsh-plugin/awesome-dsh-plugin'

function marketTitle(option: (typeof MARKET_OPTIONS)[number], t: Translate): ReactNode {
  if (option.id === 'community-market') {
    return <RepositoryLink href={COMMUNITY_MARKET_URL}>{t(option.title)}</RepositoryLink>
  }
  if (option.id === 'dsh-market') {
    return <RepositoryLink href={DSH_MARKET_URL}>{t(option.title)}</RepositoryLink>
  }
  return t(option.title)
}

function marketBody(option: (typeof MARKET_OPTIONS)[number], t: Translate): ReactNode {
  if (option.id !== 'dsh-market') return t(option.body)
  return (
    <>
      {t(option.body)}{' '}
      <RepositoryLink href={AWESOME_DSH_PLUGIN_URL}>awesome-dsh-plugin</RepositoryLink>
    </>
  )
}

/** Render the Desktop settings page. */
export function DesktopSettingsSection({
  t,
  api,
  platform,
  initialMode,
  desktopSettings,
  notificationSettings,
}: DesktopSettingsSectionProps) {
  const desktop = useScope(desktopSettings)
  const notifications = useScope(notificationSettings)
  const [view, setView] = useState<DesktopSettingsView>()
  const [profileName, setProfileName] = useState('')
  const [busy, setBusy] = useState<BusyOperation | undefined>('load')
  const [loadFailed, setLoadFailed] = useState(false)
  const [operationFailed, setOperationFailed] = useState(false)
  const [restart, setRestart] = useState<RestartState>('none')
  const [pendingProfileDelete, setPendingProfileDelete] = useState<string>()
  const [contextSize, setContextSize] = useState('8192')
  const [gpuLayers, setGpuLayers] = useState('99')
  const [speculativeDecoding, setSpeculativeDecoding] = useState(true)

  const load = useCallback(async () => {
    setBusy('load')
    setLoadFailed(false)
    setOperationFailed(false)
    try {
      setView(await api.read())
    } catch {
      setLoadFailed(true)
    } finally {
      setBusy(current => current === 'load' ? undefined : current)
    }
  }, [api])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    if (view === undefined) return
    setContextSize(String(view.localLlama.contextSize))
    setGpuLayers(String(view.localLlama.gpuLayers))
    setSpeculativeDecoding(view.localLlama.speculativeDecoding)
  }, [view?.localLlama.contextSize, view?.localLlama.gpuLayers, view?.localLlama.speculativeDecoding])
  useEffect(() => {
    if (restart !== 'restarting') return
    const timer = setTimeout(() => { setRestart('required') }, 8_000)
    return () => { clearTimeout(timer) }
  }, [restart])

  const run = useCallback(async (operation: BusyOperation, invoke: () => Promise<void>) => {
    setBusy(operation)
    setOperationFailed(false)
    try {
      await invoke()
    } catch {
      setOperationFailed(true)
    } finally {
      setBusy(current => current === operation ? undefined : current)
    }
  }, [])

  const requestRestart = (): void => { setRestart('restarting') }
  const settingsWritable = desktop.status === 'ready' && desktop.writable
  const notificationsWritable = notifications.status === 'ready' && notifications.writable
  const mode = desktop.value?.mode ?? initialMode
  const notificationValue = notifications.value ?? {
    enabled: true,
    notifyOnTurnCompletion: true,
    notifyOnTurnFailure: true,
    notifyOnJobCompletion: true,
    notifyOnJobFailure: true,
  }

  const createProfile = (event: FormEvent): void => {
    event.preventDefault()
    const name = profileName.trim()
    if (name.length === 0) return
    void run('create-profile', async () => {
      setView(await api.createProfile(name))
      setProfileName('')
    })
  }

  const selectProfile = (name: string): void => {
    void run('select-profile', async () => {
      const response = await api.selectProfile(name)
      if (response.restartRequired) requestRestart()
    })
  }

  const deleteProfile = (name: string): void => {
    void run('delete-profile', async () => {
      setView(await api.deleteProfile(name))
      setPendingProfileDelete(undefined)
    })
  }

  const selectMarket = (provider: DesktopMarketProvider): void => {
    void run('select-market', async () => {
      const response = await api.selectMarket(provider)
      setView(current => current === undefined ? current : {
        ...current,
        market: { requested: provider, effective: current.market.effective, legacyDefaulted: false },
      })
      if (response.restartRequired) requestRestart()
    })
  }

  const setLocalLlama = (localLlama: LocalLlamaView): void => {
    setView(current => current === undefined ? current : { ...current, localLlama })
  }

  const addLocalModel = (): void => {
    void run('add-model', async () => { setLocalLlama(await api.addLocalModel()) })
  }

  const selectLocalModel = (id: string): void => {
    void run('select-model', async () => { setLocalLlama(await api.selectLocalModel(id)) })
  }

  const removeLocalModel = (id: string): void => {
    void run('remove-model', async () => { setLocalLlama(await api.removeLocalModel(id)) })
  }

  const configureLocalModel = (event: FormEvent): void => {
    event.preventDefault()
    const nextContextSize = Number(contextSize)
    const nextGpuLayers = Number(gpuLayers)
    void run('configure-model', async () => {
      setLocalLlama(await api.configureLocalModel({
        contextSize: nextContextSize,
        gpuLayers: nextGpuLayers,
        speculativeDecoding,
      }))
    })
  }

  const setLocalModelRunning = (running: boolean): void => {
    void run(running ? 'start-model' : 'stop-model', async () => {
      setLocalLlama(running ? await api.startLocalModel() : await api.stopLocalModel())
    })
  }

  const setMode = (next: DesktopShellSettings['mode']): void => {
    void run('mode', async () => {
      await desktopSettings.set('mode', next)
      requestRestart()
    })
  }

  const setNotification = (field: keyof DesktopNotificationSettings, checked: boolean): void => {
    void run('notification', async () => { await notificationSettings.set(field, checked) })
  }

  return (
    <div className="dshDesktopSettings">
      <header className="dshDesktopSettingsHeader">
        <h2>{t('title')}</h2>
        <p>{t('intro')}</p>
      </header>

      {operationFailed && <p className="dshDesktopSettingsError" role="alert">{t('operationFailed')}</p>}
      {restart !== 'none' && (
        <p className="dshDesktopSettingsSuccess" role="status">
          {t(restart === 'restarting' ? 'restarting' : 'restartRequired')}
        </p>
      )}

      <section className="dshDesktopSettingsGroup" aria-labelledby="dsh-desktop-local-model-title">
        <div>
          <h3 id="dsh-desktop-local-model-title">{t('localModelTitle')}</h3>
          <p className="dshDesktopSettingsGroupIntro">{t('localModelIntro')}</p>
        </div>
        {view !== undefined && !view.localLlama.available && (
          <p className="dshDesktopSettingsNotice">{t('localModelWindowsOnly')}</p>
        )}
        {view?.localLlama.detail !== undefined && (
          <p className="dshDesktopSettingsError" role="alert">{view.localLlama.detail}</p>
        )}
        {view?.localLlama.available === true && (
          <>
            <div className="dshDesktopSettingsLocalHeader">
              <span className="dshDesktopSettingsBadge">{t(`localStatus_${view.localLlama.status}`)}</span>
              <button
                type="button"
                className="dshDesktopSettingsButton dshDesktopSettingsIconLabel"
                disabled={busy !== undefined}
                onClick={addLocalModel}
              >
                <FolderPlus size={15} aria-hidden="true" />
                {t('addLocalModel')}
              </button>
            </div>
            {view.localLlama.models.length === 0 && (
              <p className="dshDesktopSettingsHint">{t('noLocalModels')}</p>
            )}
            <div className="dshDesktopSettingsList" role="radiogroup" aria-labelledby="dsh-desktop-local-model-title">
              {view.localLlama.models.map(model => (
                <Choice
                  key={model.id}
                  title={model.name}
                  body={formatModelSize(model.size)}
                  selected={model.selected}
                  disabled={busy !== undefined || view.localLlama.status === 'starting' || view.localLlama.status === 'stopping'}
                  action={() => { selectLocalModel(model.id) }}
                  status={model.selected ? t('activeLocalModel') : undefined}
                  aside={(
                    <button
                      type="button"
                      className="dshDesktopSettingsIconButton"
                      title={t('removeLocalModel')}
                      aria-label={t('removeLocalModel')}
                      disabled={busy !== undefined}
                      onClick={(event) => {
                        event.stopPropagation()
                        removeLocalModel(model.id)
                      }}
                    >
                      <Trash2 size={15} aria-hidden="true" />
                    </button>
                  )}
                />
              ))}
            </div>
            <form className="dshDesktopSettingsLocalForm" onSubmit={configureLocalModel}>
              <label className="dshDesktopSettingsField">
                {t('contextSize')}
                <input
                  className="dshDesktopSettingsInput"
                  type="number"
                  min="512"
                  max="262144"
                  step="512"
                  value={contextSize}
                  disabled={busy !== undefined}
                  onChange={event => { setContextSize(event.currentTarget.value) }}
                />
              </label>
              <label className="dshDesktopSettingsField">
                {t('gpuLayers')}
                <input
                  className="dshDesktopSettingsInput"
                  type="number"
                  min="0"
                  max="999"
                  step="1"
                  value={gpuLayers}
                  disabled={busy !== undefined}
                  onChange={event => { setGpuLayers(event.currentTarget.value) }}
                />
              </label>
              <ToggleRow
                label={t('speculativeDecoding')}
                checked={speculativeDecoding}
                disabled={busy !== undefined}
                onChange={setSpeculativeDecoding}
              />
              <button type="submit" className="dshDesktopSettingsButton" disabled={busy !== undefined}>
                {t('saveLocalModelSettings')}
              </button>
            </form>
            <div className="dshDesktopSettingsLocalActions">
              {view.localLlama.status === 'ready' ? (
                <button
                  type="button"
                  className="dshDesktopSettingsButton dshDesktopSettingsIconLabel"
                  disabled={busy !== undefined}
                  onClick={() => { setLocalModelRunning(false) }}
                >
                  <Square size={14} aria-hidden="true" />
                  {t('unloadLocalModel')}
                </button>
              ) : (
                <button
                  type="button"
                  className="dshDesktopSettingsButton dshDesktopSettingsIconLabel"
                  disabled={busy !== undefined || view.localLlama.selectedModelId === undefined}
                  onClick={() => { setLocalModelRunning(true) }}
                >
                  <Play size={14} aria-hidden="true" />
                  {busy === 'start-model' ? t('loadingLocalModel') : t('loadLocalModel')}
                </button>
              )}
            </div>
          </>
        )}
      </section>

      <section className="dshDesktopSettingsGroup" aria-labelledby="dsh-desktop-profile-title">
        <div>
          <h3 id="dsh-desktop-profile-title">{t('profileTitle')}</h3>
          <p className="dshDesktopSettingsGroupIntro">{t('profileIntro')}</p>
        </div>
        {busy === 'load' && view === undefined && <p className="dshDesktopSettingsHint">{t('loading')}</p>}
        {loadFailed && view === undefined && (
          <div>
            <p className="dshDesktopSettingsError" role="alert">{t('unavailable')}</p>
            <button type="button" className="dshDesktopSettingsButton" onClick={() => { void load() }}>{t('retry')}</button>
          </div>
        )}
        {view !== undefined && (
          <>
            <div className="dshDesktopSettingsList" role="radiogroup" aria-labelledby="dsh-desktop-profile-title">
              {view.profiles.map((profile) => {
                const current = profile.name === view.current
                const deleteAction = profile.deletable && !current && busy === undefined && restart === 'none'
                  ? (
                    <div className="dshDesktopSettingsChoiceAside" onClick={event => { event.stopPropagation() }}>
                      {pendingProfileDelete === profile.name ? (
                        <div className="dshDesktopSettingsDeleteConfirm" role="group" aria-label={t('confirmDeleteProfile')}>
                          <span className="dshDesktopSettingsDeleteWarning">{t('deleteProfileWarning')}</span>
                          <span className="dshDesktopSettingsDeleteActions">
                            <button
                              type="button"
                              className="dshDesktopSettingsButton dshDesktopSettingsButtonDanger"
                              disabled={busy !== undefined}
                              onClick={() => { deleteProfile(profile.name) }}
                            >
                              {busy === 'delete-profile' ? t('deletingProfile') : t('confirmDeleteProfile')}
                            </button>
                            <button
                              type="button"
                              className="dshDesktopSettingsButton dshDesktopSettingsButtonSecondary"
                              disabled={busy !== undefined}
                              onClick={() => { setPendingProfileDelete(undefined) }}
                            >
                              {t('cancelDeleteProfile')}
                            </button>
                          </span>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="dshDesktopSettingsButton dshDesktopSettingsButtonSecondary"
                          onClick={() => { setPendingProfileDelete(profile.name) }}
                        >
                          {t('deleteProfile')}
                        </button>
                      )}
                    </div>
                  ) : undefined
                return (
                  <Choice
                    key={profile.name}
                    title={profile.name}
                    body={profileState(profile, t)}
                    selected={current}
                    disabled={!profile.selectable || busy !== undefined || restart !== 'none'}
                    action={() => { selectProfile(profile.name) }}
                    status={current ? t('activeProfile') : undefined}
                    aside={deleteAction}
                  />
                )
              })}
            </div>
            <form className="dshDesktopSettingsForm" onSubmit={createProfile}>
              <label className="dshDesktopSettingsField">
                {t('profileName')}
                <input
                  className="dshDesktopSettingsInput"
                  value={profileName}
                  maxLength={128}
                  autoComplete="off"
                  placeholder={t('profileNamePlaceholder')}
                  disabled={busy !== undefined || restart !== 'none'}
                  onChange={event => { setProfileName(event.currentTarget.value) }}
                />
              </label>
              <button
                type="submit"
                className="dshDesktopSettingsButton"
                disabled={profileName.trim().length === 0 || busy !== undefined || restart !== 'none'}
              >
                {busy === 'create-profile' ? t('creatingProfile') : t('create')}
              </button>
            </form>
          </>
        )}
      </section>

      <section className="dshDesktopSettingsGroup" aria-labelledby="dsh-desktop-market-title">
        <div>
          <h3 id="dsh-desktop-market-title">{t('marketTitle')}</h3>
          <p className="dshDesktopSettingsGroupIntro">{t('marketIntro')}</p>
        </div>
        {view?.market.legacyDefaulted === true && <p className="dshDesktopSettingsNotice">{t('legacyMarketNotice')}</p>}
        {view !== undefined && view.market.requested !== view.market.effective && restart === 'none' && (
          <p className="dshDesktopSettingsNotice" role="status">{t('marketLoadFailed')}</p>
        )}
        {view !== undefined && (
          <div className="dshDesktopSettingsList" role="radiogroup" aria-labelledby="dsh-desktop-market-title">
            {MARKET_OPTIONS.map(option => (
              <Choice
                key={option.id}
                title={marketTitle(option, t)}
                body={marketBody(option, t)}
                selected={view.market.requested === option.id}
                reselectable={view.market.requested === option.id && view.market.requested !== view.market.effective}
                disabled={busy !== undefined || restart !== 'none'}
                action={() => { selectMarket(option.id) }}
                status={view.market.requested === option.id && view.market.requested !== view.market.effective
                    ? t('retryMarket')
                    : view.market.requested === option.id ? t('selected') : undefined}
              />
            ))}
          </div>
        )}
      </section>

      <section className="dshDesktopSettingsGroup" aria-labelledby="dsh-desktop-presentation-title">
        <div>
          <h3 id="dsh-desktop-presentation-title">{t('presentationTitle')}</h3>
          <p className="dshDesktopSettingsGroupIntro">{t('presentationIntro')}</p>
        </div>
        {desktop.status === 'unavailable' && <p className="dshDesktopSettingsNotice">{t('readOnly')}</p>}
        <div className="dshDesktopSettingsList" role="radiogroup" aria-labelledby="dsh-desktop-presentation-title">
          <Choice
            title={t('compatibilityMode')}
            body={t('compatibilityModeBody')}
            selected={mode === 'compatibility'}
            disabled={!settingsWritable || busy !== undefined || restart !== 'none'}
            action={() => { setMode('compatibility') }}
            status={mode === 'compatibility' ? t('selected') : undefined}
          />
          <Choice
            title={t('advancedMode')}
            body={platform === 'linux' ? t('advancedUnavailableLinux') : t('advancedModeBody')}
            selected={mode === 'advanced'}
            disabled={platform === 'linux' || !settingsWritable || busy !== undefined || restart !== 'none'}
            action={() => { setMode('advanced') }}
            status={mode === 'advanced' ? t('selected') : undefined}
          />
        </div>
      </section>

      <section className="dshDesktopSettingsGroup" aria-labelledby="dsh-desktop-notifications-title">
        <div>
          <h3 id="dsh-desktop-notifications-title">{t('notificationsTitle')}</h3>
          <p className="dshDesktopSettingsGroupIntro">{t('notificationsIntro')}</p>
        </div>
        {notifications.status === 'unavailable' && <p className="dshDesktopSettingsNotice">{t('readOnly')}</p>}
        <ToggleRow
          label={t('notificationsEnabled')}
          checked={notificationValue.enabled}
          disabled={!notificationsWritable || busy !== undefined}
          onChange={checked => { setNotification('enabled', checked) }}
        />
        <div className="dshDesktopSettingsDetails">
          <ToggleRow
            label={t('turnCompletion')}
            checked={notificationValue.notifyOnTurnCompletion}
            disabled={!notificationValue.enabled || !notificationsWritable || busy !== undefined}
            onChange={checked => { setNotification('notifyOnTurnCompletion', checked) }}
          />
          <ToggleRow
            label={t('turnFailure')}
            checked={notificationValue.notifyOnTurnFailure}
            disabled={!notificationValue.enabled || !notificationsWritable || busy !== undefined}
            onChange={checked => { setNotification('notifyOnTurnFailure', checked) }}
          />
          <ToggleRow
            label={t('jobCompletion')}
            checked={notificationValue.notifyOnJobCompletion}
            disabled={!notificationValue.enabled || !notificationsWritable || busy !== undefined}
            onChange={checked => { setNotification('notifyOnJobCompletion', checked) }}
          />
          <ToggleRow
            label={t('jobFailure')}
            checked={notificationValue.notifyOnJobFailure}
            disabled={!notificationValue.enabled || !notificationsWritable || busy !== undefined}
            onChange={checked => { setNotification('notifyOnJobFailure', checked) }}
          />
        </div>
      </section>
    </div>
  )
}
