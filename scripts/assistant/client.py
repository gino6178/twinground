"""/api/assistant (2026-11-14): web-server side of the site assistant.

Request: {"messages": [...], "lang": "zh"|"en", "site": {"answer": <search answer>, "index": int} | null}
The search answer the page already holds is reduced to a text brief (site_brief) and sent with the conversation to the
model service behind ANALOG_ASSISTANT_URL (scripts/assistant/service.py).
"""
import json
import os
import re
from urllib.request import Request, urlopen

from scripts.assistant.site_brief import brief, strip_answer

URL = os.environ.get('ANALOG_ASSISTANT_URL', 'http://127.0.0.1:8791/ask')


def handle(body):
    lang = 'en' if body.get('lang') == 'en' else 'zh'
    messages = [{'role': m.get('role'), 'content': str(m.get('content', ''))[:1200]}
                for m in (body.get('messages') or [])[-6:] if isinstance(m, dict)]
    if not messages or messages[-1]['role'] != 'user' or not messages[-1]['content'].strip():
        raise ValueError('empty message')
    if re.search(r'[一-鿿]', messages[-1]['content']):  # a Chinese question gets a Chinese brief and answer
        lang = 'zh'
    site = None
    s = body.get('site')
    if isinstance(s, dict) and isinstance(s.get('answer'), dict) and s['answer'].get('matches'):
        site = brief(strip_answer(s['answer']), int(s.get('index') or 0), lang)
    req = Request(URL, data=json.dumps({'messages': messages, 'lang': lang, 'site': site}).encode('utf-8'),
                  headers={'Content-Type': 'application/json'}, method='POST')
    try:
        with urlopen(req, timeout=60) as r:
            out = json.loads(r.read())
    except OSError:
        return {'available': False, 'reason': '小助手目前沒有啟動' if lang == 'zh' else 'The assistant is not running'}
    out['available'] = 'answer' in out
    out['site_used'] = site is not None
    return out
