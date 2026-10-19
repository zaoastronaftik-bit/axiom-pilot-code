# AxiomBench (experimental runner)

24 MIT-licensed, versioned, machine-checkable scenarios in eval-v1.jsonl. Each record has an immutable ID, task, initial faulty implementation, and independent oracle cases. Extend JSONL with unique IDs for 100+ tasks. These are intentionally small correctness smoke tasks, not a claim of production coding competence. They are evaluation-only; training validation forbids overlap.

Start an actual local backend with the chosen model/context, then:

```
npm run build
node bench/run.mjs --url http://127.0.0.1:1234/v1 --model YOUR_MODEL --ctx 4096 --quantization Q4_K_M --seed 42 --allow-code-execution
```

This consent permits generated JavaScript to execute in disposable projects with your user privileges. Use a disposable VM/container for adversarial models. The runner is not an OS sandbox. The agent can edit only solution.mjs and cannot approve arbitrary commands. Tests live outside that project. Baseline and agent use the same API/model/seed/output cap/task/initial code; protocol prompts differ necessarily and are hashed. Set actual server context to the declared value; API metadata cannot prove all external backend settings.

Results are written incrementally. Missing measurements stay null; no runs → no result file/statistics. Tests-passed is null on a failed suite because per-case completion is not measured. Success requires exit 0 plus an oracle completion marker, but this is not adversarial anti-cheating isolation. No benchmark against a real model has been run in the development environment. The integration HTTP fixture does not count as a model benchmark.
