"""TwinGround assistant service (2026-11-14). Usage: python service.py <model dir> <rag dir> <e5 dir> [port]

POST /ask {"messages": [{"role": "user"|"assistant", "content": str}, ...], "lang": "zh"|"en"|null, "site": str|null}
  -> {"answer": str, "sources": [{"n", "title", "section", "url"}], "ms": int}
Listens on 127.0.0.1 only; the web server builds the [SITE] brief and forwards the request here.
Retrieval: multilingual-e5 over build/assistant (chunks.jsonl + vectors.npy); generation: the fine-tuned Llama 3.2 1B,
greedy, at most 450 new tokens. Citations outside the returned sources are removed before the answer leaves.
2026-11-15: answers follow the language of the question (the page always sends 'en'); the internal [SITE] tag leaves
as [candidate] / [候選] (or is dropped when no brief was sent); empty citation lead-ins are repaired; refusals carry no
sources; without a brief, "this site" questions get a fixed pointer and earlier candidate answers are withheld.
"""
import json
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import prompt as P  # noqa: E402

# Loaded by load() when run as the service; tests import this module and set index/generate themselves.
torch = tok = model = index = None
lock = threading.Lock()
MAX_TURNS = 6


def load(model_dir, rag_dir, e5_dir):
    global torch, tok, model, index
    import torch as _torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    from rag import Index
    torch = _torch
    tok = AutoTokenizer.from_pretrained(model_dir)
    model = AutoModelForCausalLM.from_pretrained(model_dir, torch_dtype=torch.bfloat16).cuda().eval()
    index = Index.load(rag_dir, e5_dir, device='cuda')


def generate(msgs):
    enc = tok.apply_chat_template(msgs, add_generation_prompt=True, return_tensors='pt').to('cuda')
    with lock, torch.no_grad():
        out = model.generate(enc, max_new_tokens=450, do_sample=False, repetition_penalty=1.05,
                             pad_token_id=tok.eos_token_id)
    return tok.decode(out[0][enc.shape[1]:], skip_special_tokens=True).strip()


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
     'passages it read. Ask me how to use the site, how the ranking works, which data it uses, or why a candidate '
     'was chosen.',
     '我是 TwinGround 網站的小助手，一個小型語言模型，只根據論文與網站內容回答，並列出讀過的段落。可以問我網站怎麼用、排序怎麼做、用了哪些資料，或某個候選地點為什麼被選中。'),
]


def small_talk(q, lang):
    text = re.sub(r"[\s!！?？.。,，~～、:：;；'\"()（）👋🙂😀]+", ' ', q.lower()).strip()
    for pattern, en, zh in SMALL_TALK:
        if pattern.search(text):
            return zh if lang == 'zh' else en
    return None


# Questions about "this site / this candidate" with no candidate brief (the box is unticked, or no search is open):
# the model would answer from earlier turns or invent one, so they get a fixed pointer instead.
ABOUT_CANDIDATE = re.compile(
    r"\b(?:this|that|the current|the selected) (?:candidate|location|place|spot|window)\b"
    r"|\bthis site\b.{0,40}\b(?:chosen|selected|picked|ranked|score|match|compare|tested|test|fail|good|suitable)"
    r"|\bwhy (?:was|is|did) (?:this|that) (?:site|place|candidate|location)\b"
    r"|\b(?:tested|test|do) here\b|\bat this site\b"
    r"|這個(?:地點|候選|地方|位置)|此地|目前的候選|這裡(?:適合|可以|哪些)", re.I)
NO_CANDIDATE_REPLY = {
    'en': ('No candidate is included with this question, so I cannot say anything about a specific site. Open a '
           'candidate on the results page and tick "Include the current candidate" at the top of this chat, then ask '
           'again.'),
    'zh': '這個問題沒有附上候選地點，所以我無法說明特定地點。請在結果頁打開一個候選，勾選對話框上方的「一起參考目前的候選」，再問一次。',
}
NO_SITE_HISTORY = {'en': '(An earlier answer about a candidate site, not included now.)', 'zh': '（先前關於候選地點的回答，這次未納入。）'}
SITE_MARKERS = re.compile(r'\[SITE\]|\[candidate\]|\[候選\]|\bcandidate #\d|候選 ?#\d', re.I)


def retrieve(query, k, chars, lang):
    """English answers cite English passages only (the site is English only); Chinese answers may cite either.
    lang is the language of the question, so a Chinese question still finds the Chinese paper."""
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


def prepare(history, lang, site):
    """Validate the conversation and decide what to ask the model.
    Returns (history, question language, canned reply or None, whether earlier candidate answers were withheld)."""
    history = [m for m in history if m.get('role') in ('user', 'assistant') and isinstance(m.get('content'), str)]
    history = [{'role': m['role'], 'content': m['content'][:1200]} for m in history][-MAX_TURNS:]
    if not history or history[-1]['role'] != 'user':
        raise ValueError('last message must be from the user')
    q = history[-1]['content']
    # Answer in the language of the question: the page always sends lang 'en', and filtering a Chinese question down to
    # English passages left it with nothing to cite.
    lang = P.detect_lang(q) if q.strip() else (lang if lang in ('zh', 'en') else 'en')
    canned = small_talk(q, lang)
    if not canned and not site and ABOUT_CANDIDATE.search(q):
        canned = NO_CANDIDATE_REPLY[lang]
    withheld = False
    if not site:  # earlier answers about a candidate must not stand in for the brief
        withheld = any(m['role'] == 'assistant' and SITE_MARKERS.search(m['content']) for m in history[:-1])
        history = [{'role': m['role'], 'content': NO_SITE_HISTORY[lang]}
                   if m['role'] == 'assistant' and SITE_MARKERS.search(m['content']) else m for m in history]
    return history, lang, canned, withheld


def finish(raw, passages, site, lang):
    """Post-process a generated answer and list its sources (see prompt.tidy_answer)."""
    text, used = P.tidy_answer(raw, len(passages), bool(site), lang)
    if len(re.sub(r'\W', '', text)) < 3:  # nothing left once broken citations are removed
        text = ('我在資料裡找不到答案。可以換個方式問，或到網站的論文頁看看。' if lang == 'zh' else
                'I could not find that in the sources. Try rephrasing, or look in the paper on the Methods page.')
    if not used and P.looks_refusal(text):
        return text, []  # out of scope or unknown: no sources to show
    sources = [{'n': i, 'title': p['title'], 'section': p.get('section', ''), 'url': p.get('url', ''), 'cited': i in used}
               for i, p in enumerate(passages, 1)]
    return text, sources


def answer(history, lang, site):
    history, lang, canned, withheld = prepare(history, lang, site)
    if canned:
        return canned, []
    q = history[-1]['content']
    prev = [m['content'] for m in history[:-1] if m['role'] == 'user'][-1:]  # follow-ups retrieve with the last question
    query = ' '.join(prev + [q])
    k, chars = (2, 1400) if site else (4, 2600)
    passages = retrieve(query, k, chars, lang)
    msgs = P.messages(history, passages, site, lang, no_site_note=withheld)
    return finish(generate(msgs), passages, site, lang)


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


if __name__ == '__main__':
    load(*sys.argv[1:4])
    port = int(sys.argv[4]) if len(sys.argv) > 4 else 8791
    answer([{'role': 'user', 'content': 'warm up'}], 'en', None)
    print(f'assistant on 127.0.0.1:{port}', flush=True)
    ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
