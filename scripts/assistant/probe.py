"""Probe a trained assistant before deployment (2026-11-14).

  python probe.py <model dir> <rag dir> <e5 dir> <site_cases.jsonl> [held-out dialogues.jsonl]

Runs fixed questions (general, out of scope, site explanations on real briefs) through the same retrieval and prompt as
service.py, then scores held-out teacher dialogues: share of answers with valid citations, right language and no
Simplified characters. Prints everything; nothing is written.
"""
import json
import random
import re
import sys
import time
from pathlib import Path

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

sys.path.insert(0, str(Path(__file__).parent))
import prompt as P  # noqa: E402
from rag import Index  # noqa: E402

model_dir, rag_dir, e5_dir, cases_path = sys.argv[1:5]
held = sys.argv[5] if len(sys.argv) > 5 else None
tok = AutoTokenizer.from_pretrained(model_dir)
model = AutoModelForCausalLM.from_pretrained(model_dir, torch_dtype=torch.bfloat16).cuda().eval()
index = Index.load(rag_dir, e5_dir, device='cuda')


def gen(msgs):
    enc = tok.apply_chat_template(msgs, add_generation_prompt=True, return_tensors='pt').to('cuda')
    with torch.no_grad():
        out = model.generate(enc, max_new_tokens=450, do_sample=False, repetition_penalty=1.05, pad_token_id=tok.eos_token_id)
    return tok.decode(out[0][enc.shape[1]:], skip_special_tokens=True).strip()


def ask(q, site=None, history=()):
    lang = P.detect_lang(q)
    src = index.search(q, k=2 if site else 4, max_chars=1400 if site else 2600, prefer_lang=lang)
    t0 = time.time()
    a = gen(P.messages(list(history) + [{'role': 'user', 'content': q}], src, site, lang))
    return a, src, time.time() - t0


GENERAL = ['TwinGround 是做什麼的？', '什麼是地球上限？', '為什麼地球上找不到像月海玄武岩的地方？', '網站用了哪些 NASA 資料？',
           'How is roughness compared between the Moon and Earth?', 'What is retrieval efficiency?',
           'Why can Earth not reproduce Martian night temperatures?', 'How do I search for an analog of Jezero crater?',
           '今天台北天氣如何？', 'Can you write my homework essay about Mars?', 'Who are you?']
for q in GENERAL:
    a, src, dt = ask(q)
    print(f'\n### {q}  ({dt:.1f}s)\n{a}\n  sources: ' + ' | '.join(s['title'][:40] for s in src), flush=True)

cases = [json.loads(l) for l in open(cases_path, encoding='utf-8')]
rnd = random.Random(5)
for c in rnd.sample(cases, 4):
    q = '為什麼選這個地點？' if c['lang'] == 'zh' else 'Why was this site chosen?'
    a, src, dt = ask(q, c['brief'])
    print(f"\n### SITE #{c['index'] + 1} {c['body']} {c['query']['purpose']} ({dt:.1f}s)\n{q}\n{a}", flush=True)

if held:
    rows = [json.loads(l) for l in open(held, encoding='utf-8')][:120]
    ok = cite_ok = lang_ok = 0
    for r in rows:
        msgs = r['messages'][:-1]
        n_src = len(re.findall(r'^\[\d+\] ', msgs[0]['content'], flags=re.M))
        a = gen(msgs)
        c = P.cited(a, n_src) is not None
        lg = (P.detect_lang(a) == r['lang']) and not (r['lang'] == 'zh' and P.looks_simplified(a))
        cite_ok += c; lang_ok += lg; ok += c and lg
    print(f'\nheld-out {len(rows)}: valid citations {cite_ok / len(rows):.0%}, right language {lang_ok / len(rows):.0%}, both {ok / len(rows):.0%}')
