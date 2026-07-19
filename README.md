# Agent Alpaca 🦙

A lightweight way to **watch and talk to your terminal agents from anywhere.**
Your coding agent runs on the computer at home; Agent Alpaca shows you the live
terminal on your laptop or phone and lets you type back — no screen-share, no VNC.

```bash
alpaca -- claude        # on the home machine
```

…then open the web app on any device, pick the session, and you're looking at
(and driving) the same live terminal.

## Install the CLI

One line — no npm account, no global npm install:

```bash
curl -fsSL https://raw.githubusercontent.com/JohnnyPicklesInc/AgentAlpaca/main/install.sh | sh
```

This downloads the `alpaca` bridge, installs its deps, and links an `alpaca`
command onto your PATH (override the location with `ALPACA_BIN`/`ALPACA_HOME`).
Requires Node.js 18+. Prebuilt `node-pty` binaries are bundled for macOS and
Windows (no compiler needed); on Linux `npm` builds it from source. See
[`cli/`](cli/) for the full command list.

## How it works

Same stack as its sibling apps (Cloudflare + D1 + KV + magic-link + vanilla PWA),
with a live-relay layer added:

- **`alpaca` CLI (home)** — wraps any command in a real pseudo-terminal
  ([node-pty](https://github.com/microsoft/node-pty)), mirrors output to your
  local terminal *and* the cloud, and injects remote keystrokes back into the PTY.
- **`AlpacaSession` Durable Object** — one live hub per terminal session. The
  bridge socket on one side, laptop viewer sockets on the other; it relays raw
  bytes both directions and keeps a small in-memory scrollback so a viewer that
  joins mid-session sees the current screen. **No terminal content is persisted.**
- **Worker API + D1/KV** — magic-link auth (stateless HMAC session cookie),
  bridge pairing codes, and a session registry (metadata only).
- **PWA** — session list + pairing, and an [xterm.js](https://xtermjs.org/)
  terminal view (vendored locally to keep a strict first-party CSP).

```
 HOME                          CLOUD (one Worker)                 LAPTOP
 alpaca -- claude  ── wss ──►  /ws/bridge ─► AlpacaSession ◄─ /ws/view ──  xterm.js
   node-pty PTY                    (Durable Object relay)                  term.html
```

## Develop

```bash
npm install
npm run vendor            # copy xterm.js into public/vendor (also runs in postinstall-worthy setups)
cp .dev.vars.example .dev.vars

# create local D1 + apply schema
wrangler d1 create agentalpaca          # paste the id into wrangler.toml
wrangler d1 execute agentalpaca --file=schema.sql

npm run selftest         # server-lib unit checks (no network)
npm run dev              # wrangler dev -> http://localhost:8787
```

### Try the full loop locally

1. `npm run dev`, open http://localhost:8787, sign in (dev mode prints the
   magic link to the Worker console).
2. Click **Add a bridge** → copy the `alpaca pair …` command.
3. In `cli/`: `npm install` (a postinstall step restores node-pty's
   `spawn-helper` exec bit, which npm extraction sometimes drops) then
   `node bin/alpaca.js pair ALPACA-XXXX --server http://localhost:8787`.
   (End users instead run `npx @agentalpaca/cli` — see **Install the CLI**.)
4. `node bin/alpaca.js -- bash` (or `-- claude`).
5. Back in the web app, the session appears **live** — open it and type.

## Deploy

```bash
wrangler d1 execute agentalpaca --remote --file=schema.sql
wrangler secret put SESSION_SECRET
wrangler secret put RESEND_API_KEY      # optional; without it, no emails are sent
npm run deploy
```

## Security notes

- Terminal bytes stream through the Durable Object and are **never stored**.
- Bridge tokens and magic-link/pairing codes are stored only as SHA-256 hashes.
- The WebSocket upgrade is authenticated *and* checked for session ownership in
  the Worker before it ever reaches the Durable Object.
- Anyone you sign in as can watch and **send input** to your agent — treat the
  session cookie like a remote-shell credential. Revoke a machine anytime from
  the web app (bridge revoke) or with `alpaca logout` locally.
