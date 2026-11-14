"""/api/chat-search (2026-11-12): message -> spec (fine-tuned 1B model behind ANALOG_LLM_URL) -> ranked Earth windows.
A request may instead carry a spec directly (the page's condition chips), which skips the model."""
import json
import os
import time
from urllib.request import Request, urlopen

from scripts.chat_search import search, spec as S

LLM_URL = os.environ.get('ANALOG_LLM_URL', 'http://127.0.0.1:8790/spec')


def write_spec(previous, message):
    req = Request(LLM_URL, data=json.dumps({'previous': previous, 'message': message}).encode('utf-8'),
                  headers={'Content-Type': 'application/json'}, method='POST')
    with urlopen(req, timeout=20) as r:
        return json.loads(r.read())


def handle(body, rows):
    lang = 'en' if body.get('lang') == 'en' else 'zh'
    previous = S.validate(body.get('previous') or S.empty())
    t0 = time.time()
    model = None
    mode = 'chips'
    zh = lang == 'zh'
    if isinstance(body.get('spec'), dict):
        spec = S.validate(body['spec'])
    else:
        message = str(body.get('message') or '').strip()[:600]
        if not message:
            raise ValueError('empty message')
        try:  # v2 model: one call that reads the message in context; it writes {"chat":true} for small talk
            model = write_spec(previous, message)
        except OSError:
            return {'available': False, 'reason': '對話模型目前沒有啟動' if zh else 'The language model is not running'}
        if model.get('chat'):  # greetings and small talk: answer, do not search or change the spec
            return {'available': True, 'chat_only': True, 'spec': previous, 'mode': 'small_talk',
                    'reply': S.small_talk_reply(zh, not S.is_blank(previous)), 'results': [],
                    'total_ms': round((time.time() - t0) * 1000)}
        spec = S.validate(model['spec'])
        mode = 'new' if S.is_blank(previous) or not S.carries_over(previous, spec) else 'update'
    if spec.get('target') and os.environ.get('ANALOG_CHAT_MAXMATCH', '1') == '1':
        from scripts.atlas_match import chat_maxmatch  # target named: rank by measured properties (feature model)
        result = chat_maxmatch.run(spec, rows, lang)
    else:
        result = search.run(spec, rows, lang)
    lead = '' if mode == 'chips' else S.change_text(previous, spec, mode, zh)
    top = list(dict.fromkeys(r['place']['name'] for r in result.get('results', []) if r.get('place')))[:3]  # nearby windows can share a town
    tail = (('前三名：' + '、'.join(top) + '。') if zh else (' Top three: ' + ', '.join(top) + '.')) if top else ''
    result['reply'] = (lead + (' ' if lead and not zh else '') + result['reply'] + tail).strip()
    result.update(available=True, mode=mode, model_ms=(model or {}).get('ms'), model_error=(model or {}).get('error'),
                  total_ms=round((time.time() - t0) * 1000))
    return result
