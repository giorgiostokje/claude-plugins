# claude-plugins

Giorgio Stokje's Claude Code plugins, as one marketplace.

```sh
claude plugin marketplace add giorgiostokje/claude-plugins
claude plugin install <plugin>@giorgiostokje
```

Or inside Claude Code: `/plugin marketplace add giorgiostokje/claude-plugins`, then pick from `/plugin`.

## Plugins

| Plugin | What it does |
| --- | --- |
| [bottomline](https://github.com/giorgiostokje/bottomline) | A modular status line for Claude Code, pre-packed with themes, statistics and skills. Lives in its own repo. |
| [cache-warmer](./cache-warmer) | Keeps the prompt cache warm while you're away. |

## cache-warmer

Claude Code caches the conversation so each request re-reads it cheaply, but the cache expires
after 5 minutes or 1 hour without a request. cache-warmer re-sends the cached prefix as a silent,
tool-less fork shortly before it would expire, so coming back after a break doesn't pay to rebuild it.
Nothing is added to the conversation.

- **TTL detection:** reads the TTL each request actually used from the session transcript (so the
  5-minute fallback in overage is caught), falling back to `CLAUDE_CODE_PROMPT_CACHE_TTL`, the
  `promptCacheTtl` setting, and your billing setup.
- **Break-even cap:** keeps pinging only while the pings cost less than rebuilding the cache would,
  measured from each ping's real token usage and the model's cache prices.
- **`/keepwarm`:** `status`, `on`, `off`, `now`, and `ttl 5m|1h|auto` (this session only).
- **Status line:** a `cache warm · 41m` countdown, which `showStatus` in `/config` turns off.

Options (in `/config`): `leadSeconds` (default 30), `maxWarmups` (0 = stop at break-even),
`showStatus` (default on).

It is written against Claude Code's function-hooks plugin API (early access), so it needs a
Claude Code build that has it.

## License

MIT
