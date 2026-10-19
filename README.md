# AxiomPilotCode

Local coding agent. **1.0.0-alpha.1 is a V1 production candidate, not a stable V1 release.** Fast and Deep use one selected model/backend. Local inference, editing, verification and sessions require no account. [Русский](README.ru.md) · [Readiness and blockers](docs/READINESS.md) · [Security](SECURITY.md)

The existing 0.1 CLI has been extended with strict TypeScript, managed llama.cpp, guarded file tools, context retrieval, verification and reproducible development tests. LM Studio remains a supported external API integration; it is not bundled. No telemetry, hidden cloud fallback, background service or automatic update check.

## Install this candidate from source

Node.js **22+**, npm and Git are required. Python 3.11 is required for the development fixture tests, not for ordinary CLI use. This candidate has **not been published to npm**. Build a local package:

```sh
git clone https://github.com/zaoastronaftik-bit/axiom-pilot-code.git
cd axiom-pilot-code
git checkout feat/v1-candidate
npm ci --ignore-scripts
npm run check
npm test
npm run smoke
npm pack
npm install -g --ignore-scripts ./axiom-pilot-code-1.0.0-alpha.1.tgz
pilotcode --version
pilotcode doctor
```

For reproducibility, record `git rev-parse HEAD`; the lockfile pins Node dependencies. `npm install -g axiom-pilot-code` becomes the distribution path only after the owner explicitly authorizes a release. No npm publication is performed by these instructions. Windows/Linux Node 22/24 CI and a separate opt-in GPU job are in [.github/workflows/ci.yml](.github/workflows/ci.yml).

## Native quickstart: Windows x64 + NVIDIA

The managed installer targets Windows x64 CUDA 12.4. Have a compatible NVIDIA driver and sufficient disk/RAM/VRAM. The intended acceptance machine is Windows 11, RTX 4070 SUPER 12 GB and 32 GB RAM; **that acceptance run is still outstanding**.

```sh
pilotcode runtime install
pilotcode models search qwen
pilotcode models download qwen2.5-coder-7b-q4_k_m
pilotcode runtime verify
pilotcode models verify qwen2.5-coder-7b-q4_k_m
pilotcode --backend native --model qwen2.5-coder-7b-q4_k_m --cwd ./my-project --ctx 4096
```

Each download asks first and shows source, size, license, destination and removal command. Pinned llama.cpp b11669 + CUDA dependencies total **658,026,325 bytes** compressed; the official Qwen2.5-Coder 7B Q4_K_M is **4,683,073,536 bytes**. Reserve additional disk for archives, extracted files and partial downloads. Rerun the same download to resume; completed files are reused only after SHA256 verification.

In the REPL, ask: `Inspect the failing test, fix its cause, and verify the result.` Read the exact diff and executable/arguments before approving. `/mode deep` adds planning and up to two verification repair attempts using the same model. `/sessions` then `/resume ID` restores a session for the same project/model/backend. `/undo` restores the latest agent edit only if nobody changed that file afterward. First-task time under five minutes after downloading is a target, not yet a measured claim.

Native processes bind only to loopback, use a per-launch API key and stop on normal CLI exit. Detection alone is not GPU validation: startup requires actual GPU allocation logs when offload is requested. CPU mode needs explicit `--cpu`; memory estimates are conservative, not performance guarantees. No automatic swap fallback.

## External LM Studio

Install/launch LM Studio separately, load one tool-capable model, and start its OpenAI-compatible local server. Read its license directly from its publisher.

```sh
pilotcode --backend external --url http://127.0.0.1:1234/v1 --model YOUR_LOADED_MODEL --cwd ./my-project
pilotcode run "Explain the failing test" --backend external --model YOUR_LOADED_MODEL --json
```

`external` is the explicit default and is announced at startup. `/models` lists server IDs. `/model ID` preserves the old session and creates a new one. Compatible custom loopback servers can be selected with `--url`; remote HTTPS endpoints require separate consent to send project context. Generic API compatibility does not certify every model/server. `--structured-tools` explicitly enables a strict JSON tool protocol for models without native function calls; arbitrary prose is never executed.

## Consent, commands and state

`pilotcode --help` lists implemented commands. Noninteractive execution denies writes/commands unless exact grants are supplied, for example:

```sh
pilotcode run "Fix sum.mjs" --cwd ./my-project --model YOUR_LOADED_MODEL --verify --json --allow-write sum.mjs --allow-command '["node","--test","sum.test.mjs"]'
```

The approved command must match the agent's executable and argv exactly. On Windows, Verify invokes npm through `node` + the absolute `npm-cli.js` path; use the interactive prompt to review that invocation. Never pass a broad unattended grant to an untrusted task. Approved commands have your OS permissions and may use the network; they are not sandboxed. Ctrl+C cancels a task; completed edits remain and can be undone. Exit codes: 0 completed, 1 error (130 explicit cancellation), 2 incomplete budget or non-passing verification. `--json` emits JSONL events, including the final session ID.

State: `%APPDATA%/AxiomPilotCode` on Windows; `$XDG_CONFIG_HOME/axiom-pilot-code` or `~/.config/axiom-pilot-code` elsewhere. `PILOTCODE_HOME` / `AXIOM_HOME` can override it. It contains sessions, backups, audit events, models, runtimes and local profiles. Sessions contain project excerpts and are not encrypted; protect your account/disk. Account tokens are separate and OS protected. Editable project instructions are `AGENTS.md`; there is no automatic personal-data collection.

More commands: `pilotcode verify`, `pilotcode autotune --backend native --model ID`, `models import FILE ID --license SPDX --source URL`, `models remove ID`, `runtime remove`, `runtime cleanup`, `update`, `update install`. Updates are explicit, use npm SHA512 integrity, require install consent and retain a rollback archive. Live update/rollback of a published release is not yet acceptance-tested. Remove models/runtime explicitly; uninstalling the CLI does not erase your state: `npm uninstall -g axiom-pilot-code`.

## Optional account

Local functions work without it. Set the real deployed HTTPS origin with `--api-url` or `AXIOM_API_URL`, then `pilotcode login`, `whoami`, `logout`. Login displays a code; browser opening needs consent; the browser user must separately approve. The client follows the website repository's start/poll/cli API and never approves itself. Windows stores an encrypted DPAPI blob; Linux needs an unlocked Secret Service and `secret-tool`; macOS credential integration is pending. No configured/reachable service means unavailable, not a simulated login. Server token revocation and account UI changes are in the companion website branch. [Contract and live acceptance steps](docs/ACCOUNT.md).

## Evaluation and development

```sh
npm run check
npm test
npm run smoke
python -m unittest discover -s training -p "test_*.py"
npm run pack:dry
npm run smoke:package
npm audit --omit=dev --audit-level=moderate
```

[AxiomBench](bench/README.md) contains 24 held-out coding scenarios and a real API baseline/agent runner. No real-model benchmark scores have been produced here. [AxiomTune](training/README.md) is a separate experimental QLoRA/PEFT workspace; training never runs at installation. GPU training, adapter export and quality improvement are unverified. [Troubleshooting](docs/OPERATIONS.md), [audit](docs/AUDIT.md), [architecture](docs/ADR.md), [release notes](CHANGELOG.md), [NOTICE](NOTICE) and [SBOM](docs/sbom.cdx.json) describe the candidate's boundaries.
