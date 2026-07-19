# @agentalpaca/cli 🦙

The Agent Alpaca **home bridge**. Wrap any command in a real pseudo-terminal,
keep using it locally as normal, and watch (and drive) the same live terminal
from your laptop or phone.

## Install

One line — no npm account needed:

```bash
curl -fsSL https://raw.githubusercontent.com/JohnnyPicklesInc/AgentAlpaca/main/install.sh | sh
```

Requires Node.js 18+. Prebuilt `node-pty` binaries are bundled for macOS and
Windows, so no compiler is needed there. On Linux, `npm` builds `node-pty` from
source (needs `python3` + `make` + a C++ toolchain).

## Use

```bash
alpaca pair ALPACA-7F3K          # link this machine (code from the web app)
alpaca -- claude                 # wrap a command and stream it
alpaca                           # wrap your $SHELL
alpaca status                    # show this machine's link
alpaca logout                    # revoke this machine locally
```

Config lives in `~/.agentalpaca/config.json`. See the
[project README](https://github.com/JohnnyPicklesInc/AgentAlpaca#readme) for
the full picture.
