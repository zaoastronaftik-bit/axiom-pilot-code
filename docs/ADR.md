# Architecture decisions

1. Preserve the prototype's backend → agent → tools/storage boundaries. Strict TypeScript compiles to ESM on Node 22+. Compatibility JS exports keep original regression tests useful. No plugin framework or service container.
2. One selected backend/model per session. Native is managed llama-server; external supports LM Studio at port 1234. Remote endpoints require explicit consent. No automatic cloud fallback, registration, telemetry or update checks.
3. Treat model output and repository files as untrusted. Only validated tool calls execute. Commands are executable + argv with shell:false; legacy free-form shell input cannot silently execute. An approved subprocess is not a sandbox.
4. Recheck paths and expected bytes after approval; atomic replacement + local backups; undo refuses to overwrite later user changes. Node cannot guarantee race-free directory traversal against a malicious same-user process on every OS. Do not claim a kernel sandbox.
5. Pin upstream runtime assets and SHA256. Download directly from upstream after consent; no bundled LM Studio, CUDA, model weights or third-party executables in npm. SHA256 integrity is not a publisher signature; executable provenance and Windows smoke remain explicit release gates.
6. Persistent local state under the existing PILOTCODE_HOME / platform config location. Schema migration preserves prototype histories. Account tokens use OS-protected storage; no plaintext fallback.
