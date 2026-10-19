# Operation and troubleshooting

Run `pilotcode doctor` first. It reports observed hardware, state directory, installed models/runtime and process records. It does not certify inference. `runtime status` shows the pinned upstream manifest; `runtime verify` hashes installed files. `models verify ID` hashes the model and parses bounded GGUF metadata. These can take time on multi-GB files.

| Symptom | Action |
| --- | --- |
| Native installer on Linux/macOS | Managed binary installation currently supports Windows x64 only. Use a separately installed compatible local server with `--backend external --url ...`. Linux/macOS native GPU support is not certified. |
| No NVIDIA device / CUDA DLL error | Confirm driver and `nvidia-smi`. CPU use requires explicit `--cpu`; this does not remove Windows binary/driver compatibility needs. Never infer GPU readiness from filename. |
| RAM/VRAM estimate rejected | Close other applications, reduce `--ctx` (minimum 512), or choose a smaller supported dense GGUF. `--gpu-layers N` remains bounded by measured memory and layer count. Do not force 27B onto 12 GB via swap. |
| Model selection fails | External `/models` IDs must match the loaded server model. Native `--model` is the installed catalog/import ID. Load or import first. |
| Server drops connection / malformed tool call | The request fails; no raw text executes. Inspect model/tool support. Retry explicitly or use `--structured-tools` after reviewing its strict JSON protocol. Interrupted sessions retain unresolved calls as not executed. |
| Download interruption | Rerun the same command; .part and pinned metadata permit Range resume. Incorrect range/checksum fails. If a stale .part.lock exists, confirm no downloader is alive before deleting that lock only. |
| OOM at startup | Runtime reports the real exit and bounded logs; no silent model replacement, CPU migration or success. Lower ctx/offload or choose smaller model. Hardware estimates are approximate. |
| Permission denied / noninteractive run does nothing | Review output and supply exact grants, or run in a TTY. Verify also needs command consent. A denied/unavailable check never counts as passed. |
| Windows npm command | Verify resolves npm-cli.js next to the Node installation and invokes Node with exact argv. Install standard Node 22+ if it cannot be found; .cmd/.bat are never silently shell-wrapped. |
| Context budget exhausted | `/compact`, start `/new`, narrow the task or explicitly increase `--ctx` after checking memory. Budgets include tool schemas/output reserve but use conservative character estimates, not the model tokenizer. |
| Runtime crash record remains | Inspect recorded PIDs and `doctor`. `runtime cleanup` removes dead-owner/dead-child metadata only. Live/reused PIDs are retained; unknown processes are not killed. Runtime always stops on normal exit; forced OS termination can leave a child requiring manual inspection. |
| Corrupt session | Original JSON is preserved and error gives `.bak`. Stop the CLI, copy the corrupt file aside, validate the backup then restore it. The Store.recover API is tested; no automatic overwriting of corrupted files from REPL. Concurrent stale saves fail with SESSION_CONFLICT; reload or start a new session. Inspect stale session locks only after stopping their owner. |
| Interrupted edit journal | Compare `backups/SESSION/*.json` before/after hash to the current project. A `prepared` record may mean replacement happened before a crash. Restore manually only after comparing current user edits. `/undo` operates on applied records and refuses conflicts. |
| Account service unavailable | Configure an actually deployed HTTPS API and database. Missing origin/service never creates a fake session. Local functions still work. See ACCOUNT.md. |
| OS credential storage unavailable | Windows DPAPI requires the same account; Linux requires secret-tool and an unlocked Secret Service session. No plaintext fallback. If credential saving fails the client attempts server revocation. |

VRAM guidance is approximate: 6–8 GB typically calls for smaller dense GGUFs and short context; 12 GB is the target for the official 7B Q4_K_M at ctx 4096; larger VRAM allows experiments but does not guarantee support for arbitrary architectures. The only bundled catalog entry is the pinned official Qwen model; use explicit local import with license/source for others. Dense-model metadata is required; split models and unsupported architectures fail rather than guessing.

`autotune` asks before two inference samples, reports measured TTFT/usage-derived generation rate and available memory snapshots, and saves JSON. CLI RSS is not model RAM; snapshot VRAM is not peak VRAM. Unavailable metrics remain null. The profile is a recommendation, not automatic performance optimization or a benchmark claim.

Uninstall: `npm uninstall -g axiom-pilot-code`. Remove managed models and runtime with their explicit commands. Download cache and sessions are retained. Archive the state directory before manually deleting it. Runtime/model removal never deletes a local import's original file. No system service is registered.
