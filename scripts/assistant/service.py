"""TwinGround assistant service (2026-11-14). Usage: python service.py <model dir> <rag dir> <e5 dir> [port]

POST /ask {"messages": [{"role": "user"|"assistant", "content": str}, ...], "lang": "zh"|"en"|null, "site": str|null}
  -> {"answer": str, "sources": [{"n", "title", "section", "url"}], "ms": int}
Listens on 127.0.0.1 only; the web server builds the [SITE] brief and forwards the request here.
Retrieval: multilingual-e5 over build/assistant (chunks.jsonl + vectors.npy); generation: the fine-tuned Llama 3.2 1B,
greedy, at most 450 new tokens. Citations outside the returned sources are removed before the answer leaves.
"""
import json
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

sys.path.insert(0, str(Path(__file__).parent))
import prompt as P  # noqa: E402
from rag import Index  # noqa: E402

model_dir, rag_dir, e5_dir = sys.argv[1:4]
port = int(sys.argv[4]) if len(sys.argv) > 4 else 8791
tok = AutoTokenizer.from_pretrained(model_dir)
model = AutoModelForCausalLM.from_pretrained(model_dir, torch_dtype=torch.bfloat16).cuda().eval()
index = Index.load(rag_dir, e5_dir, device='cuda')
lock = threading.Lock()
MAX_TURNS = 6


def answer(history, lang, site):
    history = [m for m in history if m.get('role') in ('user', 'assistant') and isinstance(m.get('content'), str)]
    history = [{'role': m['role'], 'content': m['content'][:1200]} for m in history][-MAX_TURNS:]
    if not history or history[-1]['role'] != 'user':
        raise ValueError('last message must be from the user')
    q = history[-1]['content']
    lang = lang if lang in ('zh', 'en') else P.detect_lang(q)
    prev = [m['content'] for m in history[:-1] if m['role'] == 'user'][-1:]  # follow-ups retrieve with the last question
    query = ' '.join(prev + [q])
    k, chars = (2, 1400) if site else (4, 2600)
    passages = index.search(query, k=k, max_chars=chars, prefer_lang=lang)
    msgs = P.messages(history, passages, site, lang)
    enc = tok.apply_chat_template(msgs, add_generation_prompt=True, return_tensors='pt').to('cuda')
    with lock, torch.no_grad():
        out = model.generate(enc, max_new_tokens=450, do_sample=False, repetition_penalty=1.05,
                             pad_token_id=tok.eos_token_id)
    text = tok.decode(out[0][enc.shape[1]:], skip_special_tokens=True).strip()
    text = re.sub(r'\[(\d{1,2})\]', lambda m: m.group(0) if 1 <= int(m.group(1)) <= len(passages) else '', text)
    used = set(int(x) for x in re.findall(r'\[(\d{1,2})\]', text))
    sources = [{'n': i, 'title': p['title'], 'section': p.get('section', ''), 'url': p.get('url', ''), 'cited': i in used}
               for i, p in enumerate(passages, 1)]
    return text, sources


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != '/ask':
            self.send_error(404)
            return
        try:
            body = json.loads(self.rfile.read(min(int(self.headers.get('Content-Length', 0)), 60000)) or b'{}')
            t0 = time.time()
            text, sources = answer(body.get('messages') or [], body.get('lang'), body.get('site'))
            out, code = {'answer': text, 'sources': sources, 'ms': round((time.time() - t0) * 1000)}, 200
        except Exception as exc:  # noqa: BLE001
            out, code = {'error': str(exc)[:200]}, 400
        data = json.dumps(out, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass


answer([{'role': 'user', 'content': 'warm up'}], 'en', None)
print(f'assistant on 127.0.0.1:{port}', flush=True)
ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
