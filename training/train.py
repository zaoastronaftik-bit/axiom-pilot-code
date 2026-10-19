"""Experimental QLoRA trainer for an explicitly downloaded HF checkpoint (not GGUF)."""
import argparse
import hashlib
import json
import os
from pathlib import Path
from validate import validate

# No logging services, uploads or implicit remote model code.
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("WANDB_DISABLED", "true")

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--model", required=True, help="Local safetensors HF checkpoint directory")
    p.add_argument("--train", required=True); p.add_argument("--eval", required=True)
    p.add_argument("--output", default="training/output/run")
    p.add_argument("--consent", action="store_true")
    p.add_argument("--resume"); p.add_argument("--max-length", type=int, default=512)
    p.add_argument("--steps", type=int, default=100); p.add_argument("--seed", type=int, default=42)
    args = p.parse_args()
    if not args.consent:
        p.error("Explicit --consent is required; use only data you have rights to train on")
    model_path = Path(args.model).resolve()
    if not model_path.is_dir() or not (model_path / "config.json").exists() or not list(model_path.glob("*.safetensors")):
        p.error("Provide a local HF safetensors checkpoint. A downloaded GGUF is not a training checkpoint")
    if not 128 <= args.max_length <= 2048 or args.steps < 1:
        p.error("Use max-length 128..2048 and positive steps")
    train, evaluation = validate(args.train, args.eval, Path(__file__).resolve().parents[1] / "bench/eval-v1.jsonl")
    import torch
    from datasets import Dataset
    from transformers import AutoTokenizer, AutoModelForCausalLM, BitsAndBytesConfig, Trainer, TrainingArguments, set_seed
    from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
    if not torch.cuda.is_available():
        raise SystemExit("CUDA GPU unavailable; training was not run")
    free, total = torch.cuda.mem_get_info()
    if free < 6 * 1024**3:
        raise SystemExit("Less than 6 GiB free VRAM; stop inference and choose a smaller checkpoint")
    set_seed(args.seed)
    bf16 = torch.cuda.is_bf16_supported()
    dtype = torch.bfloat16 if bf16 else torch.float16
    tokenizer = AutoTokenizer.from_pretrained(model_path, local_files_only=True, trust_remote_code=False)
    if not tokenizer.chat_template:
        raise ValueError("A model-provided chat template is required")
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token
    model = AutoModelForCausalLM.from_pretrained(model_path, local_files_only=True, trust_remote_code=False,
        use_safetensors=True, device_map={"": 0}, torch_dtype=dtype,
        quantization_config=BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_use_double_quant=True, bnb_4bit_compute_dtype=dtype))
    model.config.use_cache = False
    model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=True)
    model = get_peft_model(model, LoraConfig(r=8, lora_alpha=16, lora_dropout=.05,
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj"], task_type="CAUSAL_LM", bias="none"))

    def encode(row):
        messages = row["messages"]
        kw = {"tools": row["tools"]} if row.get("tools") else {}
        ids = tokenizer.apply_chat_template(messages, tokenize=True, add_generation_prompt=False, **kw)
        labels = [-100] * len(ids)
        for i, msg in enumerate(messages):
            if msg["role"] != "assistant":
                continue
            prefix = tokenizer.apply_chat_template(messages[:i], tokenize=True, add_generation_prompt=True, **kw)
            through = tokenizer.apply_chat_template(messages[:i+1], tokenize=True, add_generation_prompt=False, **kw)
            if ids[:len(prefix)] != prefix or ids[:len(through)] != through:
                raise ValueError("Chat template is not prefix-stable; assistant-only masking requires a compatible template")
            labels[len(prefix):len(through)] = ids[len(prefix):len(through)]
        ids, labels = ids[:args.max_length], labels[:args.max_length]
        if all(label == -100 for label in labels):
            raise ValueError("No assistant target tokens within max-length; curate shorter samples")
        return {"input_ids": ids, "attention_mask": [1]*len(ids), "labels": labels}

    train_data = Dataset.from_list([encode(row) for row in train])
    eval_data = Dataset.from_list([encode(row) for row in evaluation])
    def collate(rows):
        width = max(len(row["input_ids"]) for row in rows)
        return {key: torch.tensor([row[key] + [pad] * (width-len(row[key])) for row in rows])
                for key, pad in [("input_ids", tokenizer.pad_token_id), ("attention_mask", 0), ("labels", -100)]}
    out = Path(args.output)
    if out.exists() and any(out.iterdir()) and not args.resume:
        raise ValueError("Output directory is not empty; use a new path or explicit --resume checkpoint")
    out.mkdir(parents=True, exist_ok=True)
    metadata = {"experimental": True, "model": str(model_path), "model_config_sha256": hashlib.sha256((model_path/'config.json').read_bytes()).hexdigest(),
        "seed": args.seed, "max_length": args.max_length, "steps": args.steps, "gpu": torch.cuda.get_device_name(), "vram_total": total,
        "train_sha256": hashlib.sha256(Path(args.train).read_bytes()).hexdigest(), "eval_sha256": hashlib.sha256(Path(args.eval).read_bytes()).hexdigest()}
    (out/'run.json').write_text(json.dumps(metadata, indent=2))
    settings = TrainingArguments(output_dir=str(out), max_steps=args.steps, per_device_train_batch_size=1,
        per_device_eval_batch_size=1, gradient_accumulation_steps=8, learning_rate=1e-4, warmup_ratio=.03,
        optim="paged_adamw_8bit", bf16=bf16, fp16=not bf16, gradient_checkpointing=True,
        gradient_checkpointing_kwargs={"use_reentrant": False}, eval_strategy="steps", eval_steps=25,
        save_steps=25, save_total_limit=2, logging_steps=5, report_to=[], push_to_hub=False, seed=args.seed,
        dataloader_num_workers=0, save_safetensors=True)
    trainer = Trainer(model=model, args=settings, train_dataset=train_data, eval_dataset=eval_data, data_collator=collate)
    baseline = trainer.evaluate()
    try:
        trainer.train(resume_from_checkpoint=args.resume)
    except torch.cuda.OutOfMemoryError:
        torch.cuda.empty_cache()
        (out/'oom.json').write_text(json.dumps({"status": "OOM", "recommendation": "Resume last complete checkpoint with a smaller max-length or checkpoint model; no CPU fallback performed"}))
        raise SystemExit("CUDA OOM. Last completed checkpoints retained; no success result written")
    after = trainer.evaluate()
    model.save_pretrained(out/'adapter', safe_serialization=True)
    tokenizer.save_pretrained(out/'adapter')
    (out/'metrics.json').write_text(json.dumps({"baseline_eval": baseline, "adapter_eval": after, "peak_allocated_bytes": torch.cuda.max_memory_allocated(), "coding_quality": "unmeasured; run fixed AxiomBench baseline/adapter evaluation"}, indent=2))

if __name__ == "__main__":
    main()
