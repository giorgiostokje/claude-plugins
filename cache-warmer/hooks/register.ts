import type { EngineInterface, ModelUsage, Register } from 'claude-code'

import type { CacheWarmerTtl } from '../types'

const lastTouchRef = { plugin: 'cache-warmer', key: 'lastTouch' } as const
const warmupsRef = { plugin: 'cache-warmer', key: 'warmups' } as const
const spentRef = { plugin: 'cache-warmer', key: 'spent' } as const
const isEnabledRef = { plugin: 'cache-warmer', key: 'isEnabled' } as const
const transcriptPathRef = { plugin: 'cache-warmer', key: 'transcriptPath' } as const
const ttlObservedRef = { plugin: 'cache-warmer', key: 'ttlObserved' } as const
const modelRef = { plugin: 'cache-warmer', key: 'model' } as const

const TICK_MS = 5_000
// Both shorter than the lead, so a failed attempt still retries before expiry.
const API_ERROR_BACKOFF_MS = 10_000
const ABORT_BACKOFF_MS = 10_000
// A warm fork reads nearly its whole prompt from the cache; the system prompt
// alone can be cached by other sessions, so a bare non-zero read proves nothing.
const MIN_CACHED_SHARE = 0.8
const PING = 'Keep-alive ping to refresh the prompt cache. Reply with only the word: ok'
const TAIL_BYTES = [262_144, 2_097_152]

const TTL_MS: Record<CacheWarmerTtl, number> = { '1h': 60 * 60_000, '5m': 5 * 60_000 }
// Prices as multiples of the model's base input price.
const WRITE_MULTIPLIER: Record<CacheWarmerTtl, number> = { '1h': 2, '5m': 1.25 }
const OUTPUT_MULTIPLIER = 5

type Config = { leadMs: number; maxWarmups: number; showStatus: boolean }
type Snapshot = {
  lastTouch: number | null
  warmups: number
  spent: number
  isEnabled: boolean
  ttlObserved: CacheWarmerTtl | null
  model: string | null
}
type Ttl = { ttl: CacheWarmerTtl; source: string }

// Set by register(); a hot reload runs it again with fresh options.
let config: Config = { leadMs: 30_000, maxWarmups: 0, showStatus: true }
let configured: Ttl = { ttl: '1h', source: 'assumed: Claude subscription' }
let stepsInFlight = 0
let isForking = false
let backoffUntil = 0
let needsObservation = false
let lastPingCost = 0
let lastContextTokens = 0
let lastStatus: string | undefined

function readMultiplier(model: string | null): number {
  if (model === null) return 0.1
  if (/fable-5-1|mythos-5-1/.test(model)) return 0.025
  if (/opus-5-5/.test(model)) return 0.05
  return 0.1
}

function isTruthy(value: string | undefined): boolean {
  return value !== undefined && /^(1|true|yes|on)$/i.test(value.trim())
}

function isTtl(value: unknown): value is CacheWarmerTtl {
  return value === '1h' || value === '5m'
}

/** Mirrors how Claude Code picks the main conversation's TTL, as far as a mod can see. */
async function resolveConfiguredTtl($: EngineInterface): Promise<Ttl> {
  if (isTruthy(await $.env.get('FORCE_PROMPT_CACHING_5M'))) return { ttl: '5m', source: 'FORCE_PROMPT_CACHING_5M' }
  const fromEnv = await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL')
  if (isTtl(fromEnv)) return { ttl: fromEnv, source: 'CLAUDE_CODE_PROMPT_CACHE_TTL' }
  const settings = await $.settings.read()
  if (isTtl(settings.promptCacheTtl)) return { ttl: settings.promptCacheTtl, source: 'promptCacheTtl setting' }
  if (isTruthy(await $.env.get('ENABLE_PROMPT_CACHING_1H'))) return { ttl: '1h', source: 'ENABLE_PROMPT_CACHING_1H' }
  const isBedrock = isTruthy(await $.env.get('CLAUDE_CODE_USE_BEDROCK'))
  if (isBedrock && isTruthy(await $.env.get('ENABLE_PROMPT_CACHING_1H_BEDROCK'))) {
    return { ttl: '1h', source: 'ENABLE_PROMPT_CACHING_1H_BEDROCK' }
  }
  const isApiBilled =
    isBedrock ||
    isTruthy(await $.env.get('CLAUDE_CODE_USE_VERTEX')) ||
    isTruthy(await $.env.get('CLAUDE_CODE_USE_FOUNDRY')) ||
    Boolean(await $.env.get('ANTHROPIC_API_KEY')) ||
    Boolean(await $.env.get('ANTHROPIC_AUTH_TOKEN')) ||
    typeof settings.apiKeyHelper === 'string'
  if (isApiBilled) return { ttl: '5m', source: 'assumed: API key or cloud provider' }
  // Subscriptions get 1h within their usage limits and 5m in overage, which only
  // the transcript reveals.
  return { ttl: '1h', source: 'assumed: Claude subscription' }
}

function effectiveTtl(s: Snapshot): Ttl {
  return s.ttlObserved !== null ? { ttl: s.ttlObserved, source: 'observed on the last cache write' } : configured
}

async function snapshot($: EngineInterface): Promise<Snapshot> {
  const [touch, warmups, spent, enabled, observed, model] = await Promise.all([
    $.state.get(lastTouchRef),
    $.state.get(warmupsRef),
    $.state.get(spentRef),
    $.state.get(isEnabledRef),
    $.state.get(ttlObservedRef),
    $.state.get(modelRef),
  ])
  return {
    lastTouch: touch.value ?? null,
    warmups: warmups.value ?? 0,
    spent: spent.value ?? 0,
    isEnabled: enabled.value ?? true,
    ttlObserved: observed.value ?? null,
    model: model.value ?? null,
  }
}

async function arm($: EngineInterface, at: number, warmups: number, spent: number) {
  await $.state.set(lastTouchRef, at)
  await $.state.set(warmupsRef, warmups)
  await $.state.set(spentRef, spent)
}

async function disarm($: EngineInterface) {
  await $.state.set(lastTouchRef, null)
  await $.state.set(warmupsRef, 0)
  await $.state.set(spentRef, 0)
}

/** Whether another ping still costs less than rebuilding the cache would. */
function isWithinBudget(s: Snapshot, contextTokens: number): boolean {
  if (config.maxWarmups > 0) return s.warmups < config.maxWarmups
  if (lastPingCost === 0 || contextTokens === 0) return true
  const { ttl } = effectiveTtl(s)
  const breakEven = (WRITE_MULTIPLIER[ttl] - readMultiplier(s.model)) * contextTokens
  return s.spent + lastPingCost <= breakEven
}

function describe(now: number, s: Snapshot): string | undefined {
  if (s.lastTouch === null) return undefined
  const leftMs = s.lastTouch + TTL_MS[effectiveTtl(s).ttl] - now
  if (leftMs <= 0) return 'cache cold'
  const left = leftMs >= 60_000 ? `${Math.floor(leftMs / 60_000)}m` : `${Math.ceil(leftMs / 1000)}s`
  const note = isForking
    ? ' · warming'
    : !s.isEnabled
      ? ' · keep-warm off'
      : !isWithinBudget(s, lastContextTokens)
        ? ' · past break-even'
        : ''
  return `cache warm · ${left}${note}`
}

function setStatus($: EngineInterface, text: string | undefined) {
  if (!config.showStatus || text === lastStatus) return
  lastStatus = text
  $.ui.status(text)
}

async function refreshStatus($: EngineInterface) {
  const now = await $.clock.now()
  setStatus($, describe(now, await snapshot($)))
}

function tokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

function usageLine(u: ModelUsage): string {
  return (
    `cache read ${tokens(u.cache_read_input_tokens)}, cache write ${tokens(u.cache_creation_input_tokens)}, ` +
    `uncached ${tokens(u.input_tokens)}, output ${tokens(u.output_tokens)}`
  )
}

/** The TTL of the newest main-thread cache write in the transcript, if any. */
function ttlFromTranscript(tail: string): CacheWarmerTtl | null {
  // The first line is usually cut mid-row by the byte window.
  const lines = tail.split('\n').slice(1)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (line === undefined || !line.includes('"cache_creation"')) continue
    try {
      const row = JSON.parse(line)
      if (row.type !== 'assistant' || row.isSidechain === true) continue
      const created = row.message?.usage?.cache_creation
      if ((created?.ephemeral_1h_input_tokens ?? 0) > 0) return '1h'
      if ((created?.ephemeral_5m_input_tokens ?? 0) > 0) return '5m'
    } catch {
      // A partial or foreign line.
    }
  }
  return null
}

async function transcriptPath($: EngineInterface, cwd?: string): Promise<string | null> {
  const known = (await $.state.get(transcriptPathRef)).value
  if (known) return known
  if (cwd === undefined) return null
  // Claude Code's own layout, used until a classic hook hands over the real path.
  const base = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? ''}/.claude`
  return `${base}/projects/${cwd.replace(/[^a-zA-Z0-9]/g, '-')}/${await $.session.id()}.jsonl`
}

/** Reads which TTL the last request really used; reacts when it changed. */
async function observeTtl($: EngineInterface) {
  const path = await transcriptPath($)
  needsObservation = false
  if (path === null) return
  let observed: CacheWarmerTtl | null = null
  for (const bytes of TAIL_BYTES) {
    const out = await $.process.run(['tail', '-c', String(bytes), path], { timeoutMs: 5_000 })
    if (out.exitCode !== 0) return
    observed = ttlFromTranscript(out.stdout)
    if (observed !== null) break
  }
  if (observed === null) return
  const before = await snapshot($)
  if (observed === effectiveTtl(before).ttl && before.ttlObserved !== null) return
  await $.state.set(ttlObservedRef, observed)
  if (before.ttlObserved !== null && before.ttlObserved !== observed) {
    $.ui.toast(`cache-warmer: the prompt cache TTL is now ${observed} (was ${before.ttlObserved}).`, {
      timeoutMs: 10_000,
    })
  }
  // A shorter TTL may already have run out: pinging now would pay a full rewrite.
  const now = await $.clock.now()
  if (before.lastTouch !== null && before.lastTouch + TTL_MS[observed] <= now) {
    await disarm($)
    $.ui.toast(`cache-warmer: with a ${observed} TTL the cache has already expired; warming paused.`)
  }
}

/** Re-sends the main thread's last request as a fork and says what happened. */
async function warm($: EngineInterface, s: Snapshot): Promise<{ isWarm: boolean; message: string }> {
  if (isForking) return { isWarm: false, message: 'A warm-up is already running.' }
  if (s.lastTouch === null) {
    return { isWarm: false, message: 'Nothing to keep warm yet: no request since the session started.' }
  }
  isForking = true
  await refreshStatus($)
  const startedAt = await $.clock.now()
  try {
    const r = await $.model.fork({ prompt: PING })
    if (r.isAnswered || r.reason === 'empty-reply') {
      const u = r.usage
      const { ttl } = effectiveTtl(s)
      const context = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
      const cost =
        u.input_tokens +
        u.cache_read_input_tokens * readMultiplier(s.model) +
        u.cache_creation_input_tokens * WRITE_MULTIPLIER[ttl] +
        u.output_tokens * OUTPUT_MULTIPLIER
      lastPingCost = cost
      lastContextTokens = context
      if (context > 0 && u.cache_read_input_tokens / context >= MIN_CACHED_SHARE) {
        await arm($, startedAt, s.warmups + 1, s.spent + cost)
        return { isWarm: true, message: `Cache kept warm (${usageLine(u)}).` }
      }
      await disarm($)
      const message =
        `The cache had already gone cold (${usageLine(u)}); warming paused until the next request. ` +
        `TTL ${ttl} (${effectiveTtl(s).source}).`
      $.ui.toast(`cache-warmer: ${message}`, { timeoutMs: 10_000 })
      return { isWarm: false, message }
    }
    if (r.reason === 'nothing-to-fork') {
      await disarm($)
      return { isWarm: false, message: 'Nothing to keep warm: the conversation has no response yet.' }
    }
    if (r.reason === 'api-error') {
      backoffUntil = startedAt + API_ERROR_BACKOFF_MS
      return {
        isWarm: false,
        message: `Warm-up failed: API error ${r.status ?? 'without status'} (${r.error}); retrying shortly.`,
      }
    }
    backoffUntil = startedAt + ABORT_BACKOFF_MS
    return { isWarm: false, message: 'Warm-up was cut off; retrying shortly.' }
  } finally {
    isForking = false
    await refreshStatus($)
  }
}

async function tick($: EngineInterface) {
  if (needsObservation && stepsInFlight === 0 && !isForking) await observeTtl($)
  const now = await $.clock.now()
  const s = await snapshot($)
  setStatus($, describe(now, s))
  if (!s.isEnabled || s.lastTouch === null || isForking || stepsInFlight > 0) return
  if (now < backoffUntil || !isWithinBudget(s, lastContextTokens)) return
  if (now < s.lastTouch + TTL_MS[effectiveTtl(s).ttl] - config.leadMs) return
  const { isWarm, message } = await warm($, s)
  if (isWarm) $.ui.toast(`cache-warmer: ${message}`)
}

async function status($: EngineInterface): Promise<string> {
  const now = await $.clock.now()
  const s = await snapshot($)
  const { ttl, source } = effectiveTtl(s)
  const state = describe(now, s) ?? 'not armed (no request since the session started)'
  const breakEven = (WRITE_MULTIPLIER[ttl] - readMultiplier(s.model)) * lastContextTokens
  const budget =
    config.maxWarmups > 0
      ? `${s.warmups}/${config.maxWarmups} idle warm-ups used`
      : breakEven > 0
        ? `${s.warmups} idle warm-ups, ${Math.round((s.spent / breakEven) * 100)}% of break-even spent`
        : `${s.warmups} idle warm-ups`
  return (
    `Keep-warm ${s.isEnabled ? 'on' : 'off'}: ${state}. TTL ${ttl} (${source}); ` +
    `warm-up ${config.leadMs / 1000}s before expiry; ${budget}.`
  )
}

async function rememberTranscript($: EngineInterface, path: string) {
  if (path) await $.state.set(transcriptPathRef, path)
}

export const register: Register = (on, options) => {
  config = {
    // Never let the lead swallow the TTL: that would warm right after every request.
    leadMs: Math.min(Math.max(0, Number(options.leadSeconds ?? 30)) * 1000, TTL_MS['5m'] / 2),
    maxWarmups: Math.max(0, Math.floor(Number(options.maxWarmups ?? 0))),
    showStatus: options.showStatus !== false,
  }
  stepsInFlight = 0
  isForking = false
  backoffUntil = 0
  lastStatus = undefined

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    if (!e.isInteractive) return result
    configured = await resolveConfiguredTtl($)
    // Turning showStatus off in /config reloads the module: take down what the
    // previous load left on the status line.
    if (!config.showStatus) $.ui.status(undefined)
    // After a hot reload the last request may predate this module: look at once.
    needsObservation = true
    const path = await transcriptPath($, e.cwd)
    if (path !== null) await rememberTranscript($, path)
    await $.command.register({
      name: 'keepwarm',
      description: 'Prompt cache keep-warm: status, on, off, now, or ttl 5m|1h|auto (this session only).',
    })
    // A hot reload keeps $.state, so an armed lastTouch carries over; a fresh
    // session starts unarmed and arms on its first request.
    $.clock.every(TICK_MS, () => {
      void tick($)
    })
    await refreshStatus($)
    return result
  })

  on('classic.SessionStart', async ($, e, next) => {
    await rememberTranscript($, e.transcript_path)
    return next(e)
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    await rememberTranscript($, e.transcript_path)
    return next(e)
  })

  on('classic.Stop', async ($, e, next) => {
    await rememberTranscript($, e.transcript_path)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    // Subagents cache their own prefixes.
    if (e.agentId !== undefined) return yield* next(e)
    stepsInFlight += 1
    try {
      const sentAt = await $.clock.now()
      const result = yield* next(e)
      if (result.usage !== null) {
        // If our own fork surfaces as a step it touched the cache too, but it
        // is no real activity and must not reset the idle budget.
        if (isForking) {
          await $.state.set(lastTouchRef, sentAt)
        } else {
          await arm($, sentAt, 0, 0)
          await $.state.set(modelRef, result.usage.model)
          needsObservation = true
        }
        await refreshStatus($)
      }
      return result
    } finally {
      stepsInFlight -= 1
    }
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    // The compacted conversation has a new prefix; the old one is not worth keeping.
    if (e.agentId === undefined) {
      await disarm($)
      await refreshStatus($)
    }
    return result
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await disarm($)
      // A /clear continues under a new session id, so a new transcript.
      await $.state.set(transcriptPathRef, null)
      setStatus($, undefined)
    }
    return next(e)
  })

  on('command.run', { command: 'keepwarm' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'on' || arg === 'off') {
      await $.state.set(isEnabledRef, arg === 'on')
      await refreshStatus($)
      return { text: `Keep-warm is ${arg}.` }
    }
    if (arg === 'now') return { text: (await warm($, await snapshot($))).message }
    const ttlArg = /^ttl\s+(5m|1h|auto)$/.exec(arg)?.[1]
    if (ttlArg !== undefined) {
      // Claude Code reads this variable on every request, so setting it in this
      // process changes the TTL from the next request on, for this session only.
      await $.env.set('CLAUDE_CODE_PROMPT_CACHE_TTL', ttlArg === 'auto' ? undefined : ttlArg)
      configured = await resolveConfiguredTtl($)
      return {
        text:
          ttlArg === 'auto'
            ? `Cache TTL back to automatic for this session: ${configured.ttl} (${configured.source}), from the next request.`
            : `Cache TTL set to ${ttlArg} for this session, from the next request. Nothing was written to settings.`,
      }
    }
    if (arg !== '' && arg !== 'status') return { text: 'Usage: /keepwarm [status|on|off|now|ttl 5m|ttl 1h|ttl auto]' }
    return { text: await status($) }
  })
}
