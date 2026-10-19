# AxiomPilotCode

**Local-first coding agent for LM Studio.** Run your own coding assistant in Windows Terminal, PowerShell, CMD, macOS or Linux. Uses the model already loaded by LM Studio — **no cloud API is required**.

> **Status:** v0.1.0 developer preview, **not yet the planned V1.0 release**. This package is not published on npm. The current agent foundation passed automated tests, but an end-to-end test on real LM Studio / GPU hardware has not yet been performed. Model tool-call quality and performance depend on the selected model and its context settings.

## Requirements

- Node.js 20 or newer (Node.js 22 LTS recommended).
- LM Studio with a compatible model loaded (Qwen3.5-9B GGUF is a sensible starting point on RTX 4070 SUPER 12 GB).
- LM Studio **Local Server** started on `http://127.0.0.1:1234` (default). The CLI connects to `/v1`.
- A model with working **tool calling** if you want it to edit files. Some uncensored/abliterated variants may not reliably emit tool calls.

## Run from source

```powershell
git clone https://github.com/zaoastronaftik-bit/axiom-pilot-code.git
cd axiom-pilot-code
npm install
npm link
pilotcode --project C:\Projects\MyApp
```

For a local archive install, unzip the project, `cd` to its folder, then run `npm link` (no external npm dependencies).

When the npm package has been **published**, global installation will become:

```powershell
npm install -g axiom-pilot-code
pilotcode --project C:\Projects\MyApp
```

The package name is provisional until registry availability and publication are confirmed.

## Commands

| Command | Description |
| --- | --- |
| `/model` | List models available from LM Studio and choose one |
| `/mode fast` | Single-agent task execution with fewer requests |
| `/mode deep` | Planning pass, then agent work using the same selected model |
| `/new` | Start a fresh session |
| `/resume` | Resume a previous session in the same project |
| `/status` | Show connection, model, mode and current project |
| `/plugins` | Display built-in tools |
| `/update` | Check npm for an update, install with confirmation once published |
| `/settings update-check off` | Disable once-daily background version checks |
| `/help` | Display help |
| `/exit` | Exit CLI |

Other input is forwarded to the selected local AI model. The agent exposes `list_files`, `read_file`, `write_file`, and `run_command` to the model. **Writes and shell commands always require explicit confirmation**; an agent cannot silently approve them. Existing files are backed up before replacement.

## How Fast / Deep work

Both modes use the **same selected model**; `/model` controls which model is active. Fast executes the tool-using assistant loop directly. Deep first asks the same model for a concise plan, then executes the assistant loop. Unlike Fast, Deep has a larger step budget. Specialist agents, browser-based UI review and image plugins are on the roadmap, **not claimed as V1 features**.

## Configuration

| Environment variable | Purpose |
| --- | --- |
| `PILOTCODE_BASE_URL` | Override backend URL (default `http://127.0.0.1:1234/v1`) |
| `PILOTCODE_API_KEY` | Optional bearer token when backend requires authorization |
| `PILOTCODE_HOME` | Override directory for sessions, settings and backups |

Settings and session history are kept in `%APPDATA%\AxiomPilotCode` on Windows or `~/.config/axiom-pilot-code` on Linux. Text inside prompts, file contents, and tool outputs may be stored in session history. Do not submit secrets unless you accept this local storage. Backups are kept in a separate `backups/` directory.

## Permissions and safety

- Filesystem tools are restricted to the selected project root and reject paths escaping through symlinks.
- Protected paths like `.git`, `node_modules` and `.env` are unavailable through file tools.
- User approval is required for **every write** and **every shell command**. A shell command can affect files *outside* the project or access the network; review commands carefully before approving.
- Shell commands have a 30-second execution budget. This is **not a security sandbox** — run on trusted projects and decline unknown commands.
- The selected local model's ability to follow tool schemas depends on its training and quantization.
- The CLI does not automatically enable LM Studio's server or change GPU Offload settings. By default, it contacts the npm registry at most once per day to check for updates (disable with `/settings update-check off`); inference stays local.

## Development

```bash
npm run check
npm test
npm run pack:dry
```

CI runs on Windows and Ubuntu, Node.js 22 and 24. No runtime npm dependencies. MIT licensed.

## Roadmap

- Streaming UI improvements and robust context compaction
- Diff preview, Git checkpoints and rollback command
- External MCP plugin manager, browser automation and visual review
- Local image generation backend such as ComfyUI
- Sequential specialist agents / sophisticated Deep orchestration
- Signed release pipeline and automatic update notifications

The CLI is intentionally backend-agnostic through an OpenAI-compatible HTTP client, but other engines are not part of V1 verification.
