# V1 readiness matrix — 2026-10-19

**Status: 1.0.0-alpha.1 / production candidate. V1 acceptance is not complete.** Code presence is separated from runtime evidence. Full specification: [SPEC.ru.md](SPEC.ru.md). Development environment: Linux x64, Node 24.19.0, AMD EPYC, no exposed NVIDIA device/nvidia-smi. No GPU success or model-quality gain is claimed.

| Requirement | Implementation | Evidence / remaining gate |
| --- | --- | --- |
| Existing prototype preserved | Six module boundaries migrated to strict TS; compatibility exports; old-session migration; LM Studio API; Fast/Deep model identity | Original regression tests retained; restored baseline 9eadfee audited |
| Agent edit → verify → session | CLI/REPL, JSONL, exact consent, tools, cancellation, streaming validation, budgets, plan/repair loop, backups/undo | Real CLI subprocess + HTTP protocol fixture + actual Node test + persisted session passes; actual LLM/GPU vertical acceptance pending |
| Context | Ignore-aware bounded scan; symbols/imports lexical retrieval; deterministic reranking; safe optional ripgrep; whole-turn compaction; AGENTS.md | Bounded functional paths and regression tests; exact tokenizer accounting and large-repo performance not measured |
| Verify | npm, TS, unittest/pytest, cargo, go, dotnet discovery, actual processes and diagnostic dedup | Deliberately broken Node/TS/Python fixtures fail and repaired ones pass; other stacks require their tools and separate acceptance |
| Native Runtime | Pinned original Windows x64 CUDA llama.cpp archives; consent/download/extract/verify; health, model alias, per-launch key, offload evidence, shutdown, stale-record cleanup | Release metadata/flags verified against upstream; ZIP extraction tested. Windows driver/PE/DLL runtime and full GPU smoke pending |
| Model Manager | Official pinned Qwen catalog; resumable range download, size/hash; list/search/import/remove/verify; bounded GGUF parser | Protocol/filesystem tests pass; actual 4.68 GB download, split GGUF and broad catalog support not validated/supported |
| AutoTune | Conservative dense-model hardware recommendation and opt-in two-sample real calibration; local JSON profiles | No real calibration run. Prefill rate, peak model RAM/VRAM and swap measurements remain null. No parameter sweep or optimality claim |
| AxiomBench | 24 original MIT held-out scenarios; baseline and agent runner, fixed metadata, actual independent checks, incremental JSON | Oracles tested against reference/buggy implementations. **Zero real-model benchmark runs**; no improvement claim. Large-repo/100+ suite still to expand |
| AxiomTune | Opt-in local Transformers/PEFT QLoRA, licensed JSONL validator, leakage/PII filters, masking, checkpoints/resume, LoRA conversion script | Five validator tests and Python syntax pass. CUDA dependency resolution, training/OOM/restart/export/inference compatibility and before/after coding quality untested. TRL/Unsloth not integrated |
| Optional account | Exact website start/poll/cli contract; explicit browser consent; DPAPI/Secret Service; logout revocation; companion account token management | Client protocol tests and server ownership/revocation unit tests pass. **No live HTTPS API, database or test-account login**. macOS secret store pending |
| Distribution | Local npm tarball, pinned Node dependencies, EN/RU docs, NOTICE/licenses/SBOM, explicit update and rollback archive | Build/pack and local installation tested; npm publication not authorized/performed. Live published-version update/rollback pending |
| CI | Windows/Linux Node 22/24; Python checks; separate opt-in self-hosted Windows NVIDIA job | Windows/Linux Node 22/24 hosted matrix passes (linked below), including packed installation. GPU job skipped; this is not a GPU pass |
| Security/recovery | Threat model, strict paths/protocols, size/time limits, token redaction, atomic writes/journals | See SECURITY.md for residual same-user races, detached processes, crash journals and unverified publisher signatures |

## Gates before a stable V1 tag

1. On an isolated Windows 11 / RTX 4070 SUPER 12 GB machine: build/install the package, explicitly install runtime/model, run `npm run smoke:gpu` with consent, retain hardware/runtime/model hashes and logs. Verify cancellation, shutdown, model missing/corruption, port conflict and controlled OOM without project loss. Test resume and undo manually. Record first-task timing after downloads.
2. Run the same 24 AxiomBench tasks against the actual baseline and agent with identical model/quantization/context/seed/hardware. Review generated code in isolation. Publish actual JSON and methodology; null remains unknown. Do not call protocol fixtures model benchmarks.
3. Deploy/reach the website's HTTPS API with its real database and a test account. Complete browser approval, interval/expiry/cancellation, OS credential retrieval, whoami, CLI logout and account-owned revocation. Verify a second account cannot revoke the first account's token. No deployment credentials or working origin were supplied here.
4. Review executable supply-chain authenticity and CUDA distribution terms. Complete Windows installer/runtime failure-path acceptance; do not treat upstream SHA256 as a verified publisher signature.
5. Pass hosted Windows/Linux CI and repeat packed installation. Exercise update/rollback against owner-controlled published artifacts before claiming that path ready. Npm publication requires separate owner permission.
6. Keep AxiomTune explicitly experimental until its environment, real training/export and held-out quality checks pass. It must remain optional even after a V1 release.

## Recorded checks

Local `npm run check`, Node tests, protocol smoke, Python validator/syntax, `npm pack --dry-run`, isolated prefix package installation and `npm audit --omit=dev` are recorded during candidate development. Local results: 82/82 Node tests, 5/5 Python validator tests, 7/7 companion server unit tests. Isolated npm global-prefix installation passes version/catalog/doctor checks. Production npm audit: zero known advisories. The full hosted matrix passed on code commit b2227692090211984a214d67dffbcb88e27f121e: [CLI CI run 39209777952](https://github.com/zaoastronaftik-bit/axiom-pilot-code/actions/runs/39209777952). Companion server CI passed on 40565a9d438497159e98b02a3911194251c4079b: [website/API run 39183076059](https://github.com/zaoastronaftik-bit/axiom-pilot-code.PAGES/actions/runs/39183076059). Hosted Windows is Windows Server 2025, not the required Windows 11 / NVIDIA desktop. The GPU job was skipped. See [validation.json](validation.json). No Windows desktop, GPU or live-account result is implied by Linux tests.

## Published candidate

- [CLI source and review](https://github.com/zaoastronaftik-bit/axiom-pilot-code/pull/1), branch `feat/v1-candidate`.
- [Companion server/account token revocation](https://github.com/zaoastronaftik-bit/axiom-pilot-code.PAGES/pull/1), branch `feat/cli-token-revocation`.
- Both PRs remain draft because the acceptance gates above are open. No npm package or stable tag was published.

Windows CI exposed inconsistent 8.3 path normalization between Node realpath implementations and a packaged entrypoint alias mismatch. Both were fixed without relaxing symlink/junction or concurrent-edit rejection; all 82 tests pass on both hosted operating systems. The package smoke honors only proxy/cache transport settings needed for dependency installation and does not forward account/project secrets.
