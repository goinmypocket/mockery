# Bot strategies — index

Strategies registered in `server/bots/registry.ts`. Each file in this
folder describes one strategy's behavior, parameter table, and any
limitations. Per the policy in `bot-spawning-model.md` §7 these docs
are the source of truth for the parameter set; the TypeScript schema
in the strategy file must mirror them.

| id | doc | one-liner |
|---|---|---|
| `noop` | [noop.md](./noop.md) | Test dummy; never trades. |
| `random-quoter` | [random-quoter.md](./random-quoter.md) | Fixed-width two-sided quoter on a cadence. |
| `natural-player` | [natural-player.md](./natural-player.md) | Four-phase discretionary trader filling a signed target. |

See `bot-spawning-model.md` for the **Strategy / Profile / Instance /
Bot** vocabulary and how strategies are wired into a game (host config,
`SETUP_SET_BOT_CONFIG`, multi-code routing via `SETUP_SET_BOT_GROUP`).
