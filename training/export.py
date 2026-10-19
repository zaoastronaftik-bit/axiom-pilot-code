"""Export a PEFT adapter for a pinned local llama.cpp checkout; no implicit download."""
import argparse
import subprocess
from pathlib import Path

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--adapter', required=True); p.add_argument('--base', required=True)
    p.add_argument('--llama-cpp', required=True); p.add_argument('--out', required=True)
    p.add_argument('--expected-commit', required=True)
    args = p.parse_args()
    root = Path(args.llama_cpp).resolve()
    commit = subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()
    if commit != args.expected_commit:
        raise SystemExit('llama.cpp checkout differs from explicitly expected commit')
    script = root / 'convert_lora_to_gguf.py'
    adapter, base, output = Path(args.adapter).resolve(), Path(args.base).resolve(), Path(args.out).resolve()
    if not script.is_file() or not (adapter/'adapter_model.safetensors').is_file() or not (base/'config.json').is_file():
        raise SystemExit('Missing converter, adapter or local base checkpoint')
    if output.exists():
        raise SystemExit('Output exists; choose a new filename')
    import sys
    subprocess.run([sys.executable,str(script),'--base',str(base),'--outfile',str(output),'--outtype','f16',str(adapter)],check=True,cwd=root)
    with output.open('rb') as f:
        if f.read(4) != b'GGUF':
            raise SystemExit('Converter did not create a GGUF adapter')
    print('Adapter exported. Load with matching base GGUF and llama-server --lora; benchmark before claiming quality gains.')

if __name__ == '__main__':
    main()
