# AxiomTune — opt-in experiment, not a V1 quality claim

Never runs during CLI installation. No project collection or upload. Use a separate Python 3.11 virtual environment and a local, license-reviewed Hugging Face safetensors checkpoint (recommended initial experiment: Qwen2.5-Coder-1.5B-Instruct). A GGUF is an inference artifact, not a training checkpoint. Model download is a separate explicit action. Default NF4 QLoRA, rank 8, q/k/v/o projections, sequence 512, microbatch 1, accumulation 8, gradient checkpointing. These are conservative experiment defaults, **not tested 12 GB fit guarantees**. 7B training can still OOM; stop inference first.

```
python -m venv training/.venv
# Activate the environment for your shell, then:
python -m pip install -r training/requirements.txt
python training/validate.py data/train.jsonl data/eval.jsonl
python training/train.py --model /local/Qwen-checkpoint --train data/train.jsonl --eval data/eval.jsonl --output training/output/run1 --consent
# Resume only a completed checkpoint:
python training/train.py --model /local/Qwen-checkpoint --train data/train.jsonl --eval data/eval.jsonl --output training/output/run1 --resume training/output/run1/checkpoint-25 --consent
```

JSONL records: `schema:1`, unique `id`, `split:train|eval`, `license:MIT|Apache-2.0|CC0-1.0`, `source` attribution, `consent:true`, OpenAI-style `messages`, optional `tools`. No data is supplied as if it were a real licensed corpus. Validator checks tool/result pairing, JSON arguments, exact and prompt-near dedup, train/eval leakage and known AxiomBench prompts. Secret/PII regex is conservative but incomplete: human review is mandatory. Do not infer licensing from a file extension.

Trainer masks user/system/tool text and learns assistant turns only. It rejects incompatible or truncated chat templates instead of silently producing zero-loss training. Baseline/adapter eval loss, manifests and GPU peak allocation are recorded locally; loss improvement is not coding improvement. Checkpoints save every 25 steps; OOM retains completed checkpoints and writes an explicit failure. No hidden CPU/swap retry.

Adapter export uses upstream `convert_lora_to_gguf.py` from an explicitly pinned local llama.cpp checkout (review its requirements separately):

```
python training/export.py --adapter training/output/run1/adapter --base /local/Qwen-checkpoint --llama-cpp /local/llama.cpp --expected-commit FULL_COMMIT_SHA --out /local/adapter-f16.gguf
```

Run the matching base GGUF with llama-server `--lora /local/adapter-f16.gguf`, use the external backend, then repeat AxiomBench with identical seed/context/quantization/hardware. Adapter/base architecture compatibility must be tested. Export and training have not run on GPU here. No gain is claimed.

Implementation uses Transformers + PEFT directly; TRL and Unsloth are optional research alternatives, **not installed or claimed integrated**. See official [PEFT quantization](https://huggingface.co/docs/peft/developer_guides/quantization) and [Trainer 4.57.1](https://huggingface.co/docs/transformers/v4.57.1/en/main_classes/trainer). Python pins exist on PyPI; full CUDA environment resolution and smoke remain release gates.
