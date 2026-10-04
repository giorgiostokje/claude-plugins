import type { ModelUsage, On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const MIN = 60_000
const T0 = 1_000_000

const WARM: ModelUsage = {
  input_tokens: 30,
  output_tokens: 2,
  cache_read_input_tokens: 120_000,
  cache_creation_input_tokens: 0,
}
const COLD: ModelUsage = {
  input_tokens: 30,
  output_tokens: 2,
  cache_read_input_tokens: 15_000,
  cache_creation_input_tokens: 105_000,
}

type World = {
  forkUsage?: ModelUsage
  model?: string
  env?: Record<string, string>
  settings?: Record<string, unknown>
  /** The TTL each transcript row's cache write used, oldest first. */
  writes?: ('1h' | '5m')[]
}

function row(ttl: '1h' | '5m'): string {
  const cache_creation = {
    ephemeral_1h_input_tokens: ttl === '1h' ? 800 : 0,
    ephemeral_5m_input_tokens: ttl === '5m' ? 800 : 0,
  }
  return JSON.stringify({ type: 'assistant', message: { usage: { cache_creation } } })
}

/** The engine beneath the plugin: a mocked clock, in-memory state, a fake model. */
function world(on: On, w: World = {}) {
  const clock = mock.clock(on, { now: T0 })
  const env = new Map<string, string>(Object.entries({ HOME: '/home/g', ...w.env }))
  on('env.get', (_$, e) => ({ value: env.get(e.name) }))
  on('env.set', (_$, e) => {
    if (e.value === undefined) env.delete(e.name)
    else env.set(e.name, e.value)
    return { value: undefined }
  })
  const state = new Map<string, unknown>()
  const versions = new Map<string, number>()
  const seen = {
    forks: 0,
    toasts: [] as string[],
    statuses: [] as (string | undefined)[],
    commands: [] as string[],
    tails: [] as string[],
    writes: [...(w.writes ?? [])],
  }

  on('state.get', (_$, e) => {
    const id = `${e.plugin}.${e.key}`
    return { value: { value: state.get(id), version: versions.get(id) ?? 0 } } as never
  })
  on('state.set', (_$, e) => {
    const id = `${e.plugin}.${e.key}`
    state.set(id, e.value)
    const version = (versions.get(id) ?? 0) + 1
    versions.set(id, version)
    return { value: { isSet: true as const, version } }
  })
  on('settings.read', () => ({ value: w.settings ?? {} }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('process.run', (_$, e) => {
    seen.tails.push(e.argv.join(' '))
    const stdout = ['{"cut-off', ...seen.writes.map(row), ''].join('\n')
    return { value: { exitCode: 0, stdout, stderr: '' } } as never
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => {
    seen.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('ui.status', (_$, e) => {
    seen.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('model.fork', () => {
    seen.forks += 1
    return { value: { isAnswered: true as const, text: 'ok', usage: w.forkUsage ?? WARM } }
  })
  on('turn.step', async function* (_$, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'done',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: { ...WARM, model: w.model ?? 'claude-sonnet-5-5' },
    }
  })
  on('command.run', () => ({ text: 'engine' }))
  on('classic.UserPromptSubmit', () => ({}) as never)

  return { clock, seen, env }
}

async function step($: Engine, agentId?: string) {
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'claude-sonnet-5-5', messageCount: 3, agentId })
  for await (const _ of stream) {
    // drain
  }
}

function keepwarm($: Engine, args: string) {
  return $.command.run({
    command: 'keepwarm',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  } as never)
}

const start = { cwd: '/Users/g', surface: 'terminal' as const, isInteractive: true }

test('warms 30s before the 1h TTL lapses, and not before', async ($, on) => {
  const { clock, seen } = world(on, { writes: ['1h'] })
  await $.session.start(start)
  expect(seen.commands).toEqual(['keepwarm'])
  await step($)

  await clock.advance(59 * MIN)
  expect(seen.forks).toBe(0)
  await clock.advance(MIN)
  expect(seen.forks).toBe(1)
  expect(seen.toasts.at(-1)).toBe(
    'cache-warmer: Cache kept warm (cache read 120k, cache write 0, uncached 30, output 2).',
  )
  expect(seen.statuses.at(-1)).toMatch(/^cache warm · 59m$/)

  // The fork re-armed the timer from the moment it went out.
  await clock.advance(59 * MIN)
  expect(seen.forks).toBe(2)
})

test('reads the TTL the last request actually used from the transcript', async ($, on) => {
  // Nothing configured, so it assumes a subscription's 1h; the transcript says 5m.
  const { clock, seen } = world(on, { writes: ['1h', '5m'] })
  await $.session.start(start)
  await step($)
  await clock.advance(10_000)
  expect(seen.tails.at(-1)).toBe('tail -c 262144 /home/g/.claude/projects/-Users-g/sess-1.jsonl')
  expect((await keepwarm($, '')).text).toMatch(/TTL 5m \(observed on the last cache write\)/)
  await clock.advance(4 * MIN)
  expect(seen.forks).toBe(0)
  await clock.advance(30_000)
  expect(seen.forks).toBe(1)
})

test('a classic hook hands over the real transcript path', async ($, on) => {
  const { clock, seen } = world(on, { writes: ['1h'] })
  await $.session.start(start)
  await $.classic.UserPromptSubmit({ prompt: 'hi', transcript_path: '/real/t.jsonl' })
  await step($)
  await clock.advance(10_000)
  expect(seen.tails.at(-1)).toBe('tail -c 262144 /real/t.jsonl')
})

test('falls back to settings and env before anything is observed', async ($, on) => {
  const { clock, seen } = world(on, { settings: { promptCacheTtl: '5m' } })
  await $.session.start(start)
  await step($)
  expect((await keepwarm($, '')).text).toMatch(/TTL 5m \(promptCacheTtl setting\)/)
  await clock.advance(5 * MIN)
  expect(seen.forks).toBe(1)
})

test('the env var outranks the setting; an API key means 5m', async ($, on) => {
  world(on, { settings: { promptCacheTtl: '5m' }, env: { CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' } })
  await $.session.start(start)
  expect((await keepwarm($, '')).text).toMatch(/TTL 1h \(CLAUDE_CODE_PROMPT_CACHE_TTL\)/)
})

test('an API key with nothing configured assumes 5m', async ($, on) => {
  world(on, { env: { ANTHROPIC_API_KEY: 'sk-ant-x' } })
  await $.session.start(start)
  expect((await keepwarm($, '')).text).toMatch(/TTL 5m \(assumed: API key or cloud provider\)/)
})

test('a TTL that shrinks to 5m mid-session (overage) is noticed and followed', async ($, on) => {
  const { clock, seen } = world(on, { writes: ['1h'] })
  await $.session.start(start)
  await step($)
  await clock.advance(10_000)
  // Overage starts: the next request writes its cache with a 5m TTL.
  seen.writes.push('5m')
  await step($)
  await clock.advance(10_000)
  expect(seen.toasts).toContain('cache-warmer: the prompt cache TTL is now 5m (was 1h).')
  // Last request at +10s, so the ping is due at +10s + 5m - 30s.
  await clock.advance(4 * MIN)
  expect(seen.forks).toBe(0)
  await clock.advance(30_000)
  expect(seen.forks).toBe(1)
})

test('stops at break-even: about 18 pings on a 1h Sonnet cache', { timeoutMs: 30_000 }, async ($, on) => {
  const { clock, seen } = world(on, { writes: ['1h'] })
  await $.session.start(start)
  await step($)
  for (let hour = 0; hour < 30; hour++) await clock.advance(60 * MIN)
  expect(seen.forks).toBe(18)
  expect(seen.statuses).toContain('cache cold')

  await step($)
  await clock.advance(60 * MIN)
  expect(seen.forks).toBe(19)
})

test('break-even is 11 pings on a 5m Sonnet cache', async ($, on) => {
  const { clock, seen } = world(on, { writes: ['5m'] })
  await $.session.start(start)
  await step($)
  for (let hour = 0; hour < 3; hour++) await clock.advance(60 * MIN)
  expect(seen.forks).toBe(11)
})

test('break-even is 23 pings on a 5m Opus 5.5 cache (reads cost 0.05x there)', async ($, on) => {
  const { clock, seen } = world(on, { writes: ['5m'], model: 'claude-opus-5-5' })
  await $.session.start(start)
  await step($)
  for (let hour = 0; hour < 3; hour++) await clock.advance(60 * MIN)
  expect(seen.forks).toBe(23)
})

test('maxWarmups overrides the break-even cap', { options: { maxWarmups: 2 } }, async ($, on) => {
  const { clock, seen } = world(on, { writes: ['1h'] })
  await $.session.start(start)
  await step($)
  for (let hour = 0; hour < 5; hour++) await clock.advance(60 * MIN)
  expect(seen.forks).toBe(2)
})

test('a fork that finds the cache cold disarms until the next request', async ($, on) => {
  const { clock, seen } = world(on, { forkUsage: COLD, writes: ['1h'] })
  await $.session.start(start)
  await step($)
  await clock.advance(60 * MIN)
  expect(seen.forks).toBe(1)
  expect(seen.toasts.at(-1)).toMatch(/already gone cold/)
  await clock.advance(3 * 60 * MIN)
  expect(seen.forks).toBe(1)
})

test('subagent requests do not arm it, and a fresh session starts unarmed', async ($, on) => {
  const { clock, seen } = world(on)
  await $.session.start(start)
  await step($, 'agent-1')
  await clock.advance(3 * 60 * MIN)
  expect(seen.forks).toBe(0)
  expect(seen.statuses.every(s => s === undefined)).toBe(true)
})

test('/keepwarm off pauses warming, /keepwarm now warms at once', async ($, on) => {
  const { clock, seen } = world(on, { writes: ['1h'] })
  await $.session.start(start)
  await step($)

  expect((await keepwarm($, 'off')).text).toBe('Keep-warm is off.')
  await clock.advance(2 * 60 * MIN)
  expect(seen.forks).toBe(0)

  await step($)
  expect((await keepwarm($, 'now')).text).toMatch(/kept warm/)
  expect(seen.forks).toBe(1)
  expect((await keepwarm($, '')).text).toMatch(
    /^Keep-warm off: cache warm · 60m · keep-warm off\. TTL 1h \(observed on the last cache write\); warm-up 30s before expiry; 1 idle warm-ups, 5% of break-even spent\.$/,
  )
  expect((await keepwarm($, 'bogus')).text).toMatch(/^Usage/)
})

test('/keepwarm ttl sets the TTL for this process only, and auto undoes it', async ($, on) => {
  const { env } = world(on)
  await $.session.start(start)
  expect((await keepwarm($, 'ttl 5m')).text).toBe(
    'Cache TTL set to 5m for this session, from the next request. Nothing was written to settings.',
  )
  expect(env.get('CLAUDE_CODE_PROMPT_CACHE_TTL')).toBe('5m')
  expect((await keepwarm($, '')).text).toMatch(/TTL 5m \(CLAUDE_CODE_PROMPT_CACHE_TTL\)/)
  expect((await keepwarm($, 'ttl auto')).text).toMatch(/^Cache TTL back to automatic for this session: 1h/)
  expect(env.has('CLAUDE_CODE_PROMPT_CACHE_TTL')).toBe(false)
})

test('looks at the transcript right after a (re)load, before any new request', async ($, on) => {
  const { clock, seen } = world(on, { writes: ['5m'] })
  await $.session.start(start)
  await clock.advance(5_000)
  expect(seen.tails).toHaveLength(1)
  expect((await keepwarm($, '')).text).toMatch(/TTL 5m \(observed on the last cache write\)/)
})

test('showStatus off clears the line and never draws the countdown', { options: { showStatus: false } }, async ($, on) => {
  const { clock, seen } = world(on, { writes: ['1h'] })
  await $.session.start(start)
  await step($)
  await clock.advance(60 * MIN)
  expect(seen.forks).toBe(1)
  expect(seen.statuses).toEqual([undefined])
})
