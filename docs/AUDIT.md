# Audit and delivery plan — 2026-10-19

Initial inspection at d4dac8d found README only. The owner then restored the prototype at **9eadfee6bf10acec762de75438b7bcac7a8ec150**. Development was paused, the initial foundation stashed, and the working branch fast-forwarded before further changes. All six modules, four test files, README, MIT license and CI were read. Baseline: 9/9 tests pass on Linux Node 24.19.0; syntax checks pass. No NVIDIA device or nvidia-smi is exposed here.

Preserve: OpenAI-compatible LM Studio streaming, model identity in Fast/Deep, explicit approvals, session location and old-session migration, project flag alias, package command and MIT attribution. Migrate these module boundaries to strict TypeScript, keeping compatibility exports and regression tests.

Findings:
- Commands use shell:true; timeout kills only parent and does not receive generation cancellation.
- Files are checked before the approval wait but not revalidated afterward; symlink substitution / concurrent edit risk. Secret denylist is incomplete; UTF-8 decoding is lossy.
- Replacements have backups but no preview, undo, expected-content check or recovery schema.
- HTTP requests with a supplied abort signal lose the timeout; SSE EOF can be accepted as completion; no size budgets/retry limits.
- Cancellation/errors do not persist an interrupted conversation; no task time/token budget.
- Default daily npm requests violate offline-by-default expectation. Updater has no pinned artifact or rollback.
- No native runtime, model manager, context retrieval, verification runner, calibration, benchmarks, training or account integration exists.

Website audit: main 48b141c5b9ca83e017228a5bdb2f98936bf1c6b8. Device start/poll/approve and GET /api/cli are implemented. Poll issues 90-day hashed CLI tokens. Revocation columns exist but endpoint/UI do not. api-config.js has an empty origin. Service README explicitly says real DB/live integration has not run. No cloud deployment or database creation is inferred from this task.

Phases: (1) safety + runtime/model/install + edit/verify/persist; (2) Context/Verify and management; (3) AutoTune/Bench; (4) experimental training and optional device auth; (5) adversarial tests, CI, documentation and release gates. Do not call this V1 stable without Windows 11 / 12 GB NVIDIA smoke, real model baseline/agent benchmark, and live account validation.
