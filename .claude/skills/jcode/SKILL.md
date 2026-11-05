---
name: jcode
description: Delegate coding tasks to jcode (github.com/1jehuang/jcode), a fast Rust coding-agent CLI, through OpenRouter. Use when the user asks to "use jcode", to hand a task to jcode, or to get a second agent's take or parallel work on this repo.
---

# Using jcode

jcode is a coding-agent CLI written in Rust. In cloud sessions it is built from
source by the environment's setup script and installed as `jcode`
(at `/usr/local/bin` or `~/.cargo/bin`).

## Check it is available

```bash
command -v jcode && jcode --version
```

If it is missing, build it (takes about 10 minutes on 4 CPUs):

```bash
git clone --depth 1 https://github.com/1jehuang/jcode /tmp/jcode-src
cd /tmp/jcode-src && cargo build --release --bin jcode
install -m755 target/release/jcode /usr/local/bin/jcode
```

`jcode.sh` and GitHub release downloads are blocked by this environment's
network policy, so the official `curl https://jcode.sh/install | bash` installer
does not work here.

## Auth

The model provider is OpenRouter. The real key is saved as an environment
network secret for `openrouter.ai`, and the proxy injects it into the
`Authorization` header. jcode only needs a placeholder value in the env var.

**Never** put a real key in the command, a file, or the chat.

Check the key works:

```bash
curl -s -H "Authorization: Bearer proxy-injected" https://openrouter.ai/api/v1/key
```

A 401 "Missing Authentication header" means the saved secret is empty or
malformed. Ask the user to re-save the raw `sk-or-...` key in the environment's
network secrets.

## Run a task (non-interactive)

```bash
OPENROUTER_API_KEY=proxy-injected JCODE_NO_TELEMETRY=1 \
  jcode --provider openrouter \
  --no-update -C /home/user/jenkins-sample \
  run "<task description>"
```

- `run` sends one message and exits. Add `--json` for a single JSON result, or
  `--ndjson` to stream events.
- `-C/--cwd` sets the repo jcode works in.
- The default model is `anthropic/claude-opus-5.5`. Pass `-m/--model <openrouter-model-id>` to use a different one.
- Do not use the TUI (plain `jcode`) or `serve`/`swarm` daemons from a
  non-interactive shell.

## After jcode runs

jcode edits files directly. Always review its changes with `git diff` before
committing, run the repo's checks (`mvn -q test` for this repo), and report to
the user what jcode did versus what you did.
