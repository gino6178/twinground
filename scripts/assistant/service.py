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


# Greetings, thanks and "who are you" carry no question: the 1B model would answer whatever passages retrieval happens
# to return ("Hi" -> an Earth Ceiling summary). They get a fixed reply with no sources instead.
SMALL_TALK = [
    (re.compile(r"^(hi+|hey+|hello+|yo|hiya|howdy|sup|good (morning|afternoon|evening|day)|greetings|哈囉|哈啰|嗨+|你好|您好|安安|早安|午安|晚安)( there| twinground| assistant)?$"),
     'Hi! I can answer questions about TwinGround: how to use the site, the method and results in the paper, the data '
     'behind it, and why a candidate site was selected. What would you like to know?',
     '嗨！我可以回答關於 TwinGround 的問題：網站怎麼用、論文的方法與結果、使用的資料，以及某個候選地點為什麼被選中。想知道什麼？'),
    (re.compile(r"^(thanks?( you)?( a lot| so much| very much)?|thx|ty|cheers|great|nice|cool|ok(ay)?|got it|謝謝(你|您)?|感謝|多謝|好的?|了解)$"),
     'Glad to help. Ask me anything else about TwinGround.', '很高興幫上忙，還有其他關於 TwinGround 的問題都可以問我。'),
    (re.compile(r"^(bye+|goodbye|see (you|ya)|再見|掰掰|拜拜)$"), 'Goodbye!', '再見！'),
    (re.compile(r"^(who|what) are you|^what can you do|^what do you do|^how can you help|^help$|^你是誰|^你可以做什麼|^你能做什麼|^你會什麼"),
     'I am the TwinGround site assistant, a small language model that answers from the paper and the site and lists the '
     'passages it read. Ask me how to use the site, how the ranking works, which NASA data it uses, or why a candidate '
     'was chosen.',
     '我是 TwinGround 網站的小助手，一個小型語言模型，只根據論文與網站內容回答，並列出讀過的段落。可以問我網站怎麼用、排序怎麼做、用了哪些 NASA 資料，或某個候選地點為什麼被選中。'),
]


def small_talk(q, lang):
    text = re.sub(r"[\s!！?？.。,，~～、:：;；'\"()（）👋🙂😀]+", ' ', q.lower()).strip()
    for pattern, en, zh in SMALL_TALK:
        if pattern.search(text):
            return zh if lang == 'zh' else en
    return None


def retrieve(query, k, chars, lang):
    """English answers cite English passages only (the site is English only); Chinese answers may cite either."""
    if lang != 'en':
        return index.search(query, k=k, max_chars=chars, prefer_lang=lang)
    out, used = [], 0
    for p in index.search(query, k=k * 4, max_chars=chars * 4, prefer_lang=lang):
        if p.get('lang') == 'zh' or (out and used + len(p['text']) > chars):
            continue
        out.append(p)
        used += len(p['text'])
        if len(out) >= k:
            break
    return out


def answer(history, lang, site):
    history = [m for m in history if m.get('role') in ('user', 'assistant') and isinstance(m.get('content'), str)]
    history = [{'role': m['role'], 'content': m['content'][:1200]} for m in history][-MAX_TURNS:]
    if not history or history[-1]['role'] != 'user':
        raise ValueError('last message must be from the user')
    q = history[-1]['content']
    lang = lang if lang in ('zh', 'en') else P.detect_lang(q)
    canned = small_talk(q, lang)
    if canned:
        return canned, []
    prev = [m['content'] for m in history[:-1] if m['role'] == 'user'][-1:]  # follow-ups retrieve with the last question
    query = ' '.join(prev + [q])
    k, chars = (2, 1400) if site else (4, 2600)
    passages = retrieve(query, k, chars, lang)
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
