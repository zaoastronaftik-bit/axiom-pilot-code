# Changes

## 1.0.0-alpha.1 — V1 candidate, 2026-10-19

Extends the restored 0.1 prototype (9eadfee) while preserving the command name, MIT attribution, external LM Studio API, single-model Fast/Deep behavior and old-session migration.

- Strict TypeScript modules, bounded SSE/tool protocol, cancellation/time/context/tool budgets.
- Guarded UTF-8 file access, diff approvals, exact-content edits, backups/undo, audit and atomic session snapshots.
- Context retrieval, optional safe-stdin ripgrep search, stack discovery and actual verification subprocesses.
- Pinned Windows CUDA llama.cpp installer, SHA256/resume model downloads, GGUF metadata, measured NVIDIA detection and conservative memory estimates.
- Opt-in calibration, 24-case AxiomBench runner and separate experimental QLoRA/export workspace.
- Exact website device-code API integration with OS credential storage; companion server/UI token revocation.
- Explicit update staging with integrity and recovery archive; Windows/Linux CI, development and GPU smoke scripts.

Breaking safety changes: Node 22+ required; free-form legacy shell strings no longer execute. Commands require executable/argv and explicit consent. Native model changes require restarting runtime. Global installation uses compiled dist; build before running source compatibility entry points. No npm publication, full V1 readiness, GPU success, benchmark gains or live account success is claimed. See docs/READINESS.md.
