# Security model and review

This is a release candidate. Do not treat the CLI or its generated code as an OS sandbox. Report vulnerabilities privately through the repository's GitHub security reporting facility when enabled; do not include real tokens, private source or exploit data in public issues.

## Trust boundaries

Model responses, repository content (including AGENTS.md), API responses and downloaded archives are untrusted inputs. The user's terminal approvals are authoritative. Host OS, the installed Node executable, trusted PATH programs and the per-user Axiom state directory are part of the trusted computing base. A malicious process already running as the same OS user can change that state, inspect process memory or interfere with approved programs; this implementation does not isolate it.

| Threat | Implemented control | Residual boundary |
| --- | --- | --- |
| Model requests secrets, shell injection or unrelated writes | Strict tool names/arguments; no implicit shell; exact executable/argv or path consent; deny without TTY/grant; context marked untrusted | Prompt injection can still persuade a user. Read every requested diff/command. Approved commands have full user rights and network access. |
| Traversal, symlink/hardlink escape, invalid UTF-8, oversized file | Path component denylist; realpath/lstat checks; O_NOFOLLOW where available; handle/path identity checks; no hardlinked reads; bounded fatal UTF-8 decoding | Node lacks portable handle-relative rename/openat semantics. Same-user adversarial directory rename between final check and rename is not fully excluded. No kernel-level race-free claim. |
| Overwriting concurrent user changes | Expected-content hashes, revalidation after consent, pre-rename comparison, atomic replace, local journal and undo conflict checks | External commands are not transactional. Power loss between replace and journal update may leave a prepared backup requiring manual inspection. |
| Malicious ZIP/download | HTTPS host allowlist, pinned size/SHA256, validated range, quotas, traversal/duplicate/symlink/special-file rejection, exclusive staging | SHA256 derives trust from reviewed upstream HTTPS metadata. Publisher signatures/attestations and Authenticode verification are not implemented. Executable provenance is a release gate. |
| Runaway model/subprocess | Step/tool/time/output/context budgets, HTTP timeouts, Ctrl+C, bounded output, POSIX process-group TERM/KILL and Windows taskkill tree | Commands that deliberately detach/reparent can escape process-tree cleanup. Windows Job Objects/graceful CTRL_BREAK integration is pending. No service/watchdog on crash. |
| GPU/host exhaustion | Measured nvidia-smi free memory, conservative dense-GGUF estimates, reserved VRAM, capped host RAM, explicit CPU choice, runtime health and offload logs | Other applications can allocate between measurement and load. Estimates do not cover all architectures, fragmentation or every KV layout. Actual OOM must be handled by the runtime. |
| Token theft/account cross-tenant action | HTTPS device flow; no auto-approval; polling interval/deadline; DPAPI/Secret Service; hashed server tokens; expiry/revocation; ownership in revoke query | Live HTTPS/DB/browser account validation remains outstanding. DPAPI protects at rest for current user, not against compromised user processes. |
| Secret leakage through logs | Secret path denylist, credential patterns redacted, audit stores argument hashes, terminal controls stripped | Regex cannot identify every secret or PII; sessions contain prompts/code, backups contain prior file contents. State is local and not encrypted except account credentials. |

## Supply chain

Two direct production packages, exact lockfile pins, `npm ci --ignore-scripts`, dependency audit in CI and Dependabot. `yauzl` was raised from 3.2.0 to 3.4.0 after the audit reported GHSA-gmq8-994r-jv83. Production audit reports zero known advisories at the recorded check; this is not proof of absence of vulnerabilities. `docs/sbom.cdx.json` records the resolved Node tree, not optional CUDA or Python environments. Runtime archives and weights are fetched directly from official publishers after consent; no binary redistribution is claimed.

## Recovery and least privilege

Use a dedicated user/disposable VM for untrusted repositories, benchmark-generated code or training experiments. Keep version-control backups. A session-scoped permission covers future changes to the exact target; `/permissions reset` clears it. Session saves use exclusive locks and loaded-snapshot hashes to reject stale writers. Concurrent processes should still use different sessions; do not edit live state files. After a crash, inspect `doctor`, runtime process records and backup journals. `runtime cleanup` removes only records whose recorded owner and child PIDs are both dead; it never kills a PID from a stale file. PID reuse is treated conservatively as alive. Stale download/install locks require checking that the owner process is stopped before removing a lock.

Security tests cover negative paths, approval-time root/parent replacement, hardlinks, UTF-8, concurrent content change, undo conflict, cancellation during approval, malformed streaming tool calls, malicious ZIP entries, corrupt downloads and device-flow boundaries. The development audit is not an independent penetration test.
