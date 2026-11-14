"""Spec-writer service (2026-11-12). Usage: python llm_service.py <model dir> [port]
POST /spec {"previous": spec, "message": str} -> {"spec": spec, "chat": bool, "raw": str, "ms": int}. Listens on 127.0.0.1 only;
the web server calls it. Output outside the closed vocabularies is rejected and the previous spec is kept."""
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

sys.path.insert(0, str(Path(__file__).parent))
import spec as S  # noqa: E402

model_dir = sys.argv[1]
port = int(sys.argv[2]) if len(sys.argv) > 2 else 8790
tok = AutoTokenizer.from_pretrained(model_dir)
model = AutoModelForCausalLM.from_pretrained(model_dir, torch_dtype=torch.bfloat16).cuda().eval()
lock = threading.Lock()


def write_spec(previous, message):
    prev = S.validate(previous or S.empty())
    prompt = tok.apply_chat_template(S.prompt_messages(prev, message), tokenize=False, add_generation_prompt=True)
    enc = tok(prompt, return_tensors='pt', add_special_tokens=False).to('cuda')
    with lock, torch.no_grad():
        g = model.generate(**enc, max_new_tokens=200, do_sample=False, pad_token_id=tok.eos_token_id)
    raw = tok.decode(g[0][enc['input_ids'].shape[1]:], skip_special_tokens=True).strip()
    kind, spec = S.parse_output(raw, prev)   # v2 models write {"chat":true} for small talk
    return spec, raw, ('unreadable output' if kind == 'error' else None), kind == 'chat'


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != '/spec':
            self.send_error(404); return
        try:
            body = json.loads(self.rfile.read(min(int(self.headers.get('Content-Length', 0)), 20000)) or b'{}')
            message = str(body.get('message', ''))[:600]
            t0 = time.time()
            spec, raw, err, chat = write_spec(body.get('previous'), message)
            out = {'spec': spec, 'chat': chat, 'raw': raw, 'error': err, 'ms': round((time.time() - t0) * 1000)}
            code = 200
        except Exception as exc:  # noqa: BLE001
            out, code = {'error': str(exc)[:200]}, 400
        data = json.dumps(out, ensure_ascii=False).encode('utf-8')
        self.send_response(code); self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)

    def log_message(self, *a):
        pass


write_spec(None, 'warm up')
print(f'spec writer on 127.0.0.1:{port}', flush=True)
ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
