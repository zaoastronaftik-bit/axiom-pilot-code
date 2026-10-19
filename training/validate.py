"""Validate explicitly contributed licensed conversations; no project harvesting."""
import argparse
import hashlib
import json
import re
from pathlib import Path

LICENSES = {"MIT", "Apache-2.0", "CC0-1.0"}
SENSITIVE = re.compile(r"(?:-----BEGIN .*PRIVATE KEY|axiom_cli_[\w-]+|\b(?:sk|ghp)_[A-Za-z0-9]{16,}|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\b(?:\+\d[\d ()-]{9,}\d))")

def normalized(value):
    return " ".join(str(value).lower().split())

def load_dataset(file, split):
    records = []
    for line_no, line in enumerate(Path(file).read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        row = json.loads(line)
        if row.get("schema") != 1 or row.get("split") != split or row.get("license") not in LICENSES:
            raise ValueError(f"{file}:{line_no}: invalid schema/split/license")
        if row.get("consent") is not True or not isinstance(row.get("source"), str) or not row["source"].strip():
            raise ValueError(f"{file}:{line_no}: explicit consent and attribution required")
        messages = row.get("messages")
        if not isinstance(messages, list) or not messages or len(messages) > 100:
            raise ValueError("Invalid conversation")
        has_assistant = False
        pending = set()
        for message in messages:
            role = message.get("role")
            if role not in {"system", "user", "assistant", "tool"}:
                raise ValueError("Invalid role")
            if message.get("content") is not None and not isinstance(message["content"], str):
                raise ValueError("Content must be text or null")
            has_assistant |= role == "assistant"
            for call in message.get("tool_calls", []):
                if role != "assistant" or call.get("id") in pending or not call.get("id"):
                    raise ValueError("Invalid tool call id")
                function = call.get("function", {})
                if not isinstance(function.get("name"), str) or not isinstance(json.loads(function.get("arguments", "")), dict):
                    raise ValueError("Invalid function arguments")
                pending.add(call["id"])
            if role == "tool":
                if message.get("tool_call_id") not in pending:
                    raise ValueError("Orphan tool result")
                pending.remove(message["tool_call_id"])
        if pending or not has_assistant:
            raise ValueError("Incomplete conversation")
        payload = json.dumps(messages, sort_keys=True, ensure_ascii=False)
        if len(payload) > 100_000 or SENSITIVE.search(payload):
            raise ValueError(f"{file}:{line_no}: potential secret/PII or oversized conversation; review locally")
        records.append(row)
    if not records:
        raise ValueError(f"Empty {split} dataset")
    return records

def validate(train_file, eval_file, bench_file=None):
    train, evaluation = load_dataset(train_file, "train"), load_dataset(eval_file, "eval")
    ids, exact, prompts = set(), set(), []
    benchmark = []
    if bench_file:
        benchmark = [normalized(json.loads(line)["prompt"]) for line in Path(bench_file).read_text().splitlines() if line.strip()]
    for row in train + evaluation:
        identity = row.get("id")
        if not isinstance(identity, str) or not identity or identity in ids:
            raise ValueError("Missing or duplicate id across splits")
        ids.add(identity)
        text = normalized(json.dumps(row["messages"], sort_keys=True, ensure_ascii=False))
        digest = hashlib.sha256(text.encode()).hexdigest()
        if digest in exact:
            raise ValueError("Duplicate conversation across or within splits")
        exact.add(digest)
        prompt = normalized(" ".join(m.get("content") or "" for m in row["messages"] if m["role"] == "user"))
        if any(b in prompt or prompt in b for b in benchmark):
            raise ValueError("AxiomBench evaluation content cannot be training/evaluation conversation input")
        words = prompt.split()
        grams = {tuple(words[i:i+3]) for i in range(max(0, len(words)-2))}
        for old_prompt, old_grams, old_split in prompts:
            similarity = len(grams & old_grams) / max(1, len(grams | old_grams))
            if prompt == old_prompt or (row["split"] != old_split and similarity >= .8):
                raise ValueError("Duplicate/near-duplicate task; split leakage")
        prompts.append((prompt, grams, row["split"]))
    return train, evaluation

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("train"); parser.add_argument("eval")
    parser.add_argument("--bench", default=str(Path(__file__).resolve().parents[1] / "bench/eval-v1.jsonl"))
    args = parser.parse_args()
    a, b = validate(args.train, args.eval, args.bench)
    print(json.dumps({"train": len(a), "eval": len(b), "status": "validated", "pii_filter": "heuristic, human review still required"}))
