"""Search spec for conversational analog search (2026-11-12).

A spec is what the fine-tuned 1B model writes and what the ranking service reads:
  {"target": str|null, "body": "moon"|"mars"|null, "conditions": {cond: "must"|"prefer"|"avoid"},
   "region": str|null, "exclude_regions": [str], "exclude_known": bool, "top_k": int}
The vocabularies below are closed: the model may only use these keys, and the service checks every spec against them.
"""
import json

IMPORTANCE = ('must', 'prefer', 'avoid')
TOP_K = (5, 10, 20, 30)
DEFAULT_TOP_K = 10

# condition id -> (Earth field rule, zh label, en label). Rules live in service.py; labels are for replies.
CONDITIONS = {
    'dry': ('乾燥', 'dry'),
    'hyperarid': ('極度乾燥', 'hyper-arid'),
    'bare': ('裸露地表', 'bare ground'),
    'cold': ('寒冷', 'cold'),
    'hot': ('炎熱', 'hot'),
    'permafrost': ('凍土', 'permafrost'),
    'ice_sheet': ('冰原或冰川', 'ice sheet or glacier'),
    'low_sun': ('低太陽角（高緯度）', 'low sun (high latitude)'),
    'volcanic': ('靠近玄武岩火山', 'near a basaltic volcano'),
    'basalt': ('玄武岩', 'basalt'),
    'anorthosite': ('斜長岩類（基性深成岩）', 'anorthosite-like plutonic rock'),
    'sedimentary': ('沉積岩', 'sedimentary rock'),
    'dunes': ('沙丘', 'sand dunes'),
    'evaporite': ('鹽灘或蒸發岩', 'salt flats or evaporites'),
    'clay': ('富黏土', 'clay-rich soil'),
    'rugged': ('高起伏地形', 'rugged relief'),
    'flat': ('平坦', 'flat ground'),
    'accessible': ('靠近道路', 'near a road'),
    'remote': ('偏遠', 'remote'),
    # facets v6 (2026-11-13): climate, altitude, caves and impact structures
    'extreme_cold': ('極低溫', 'extreme cold'),
    'big_swing': ('日夜溫差大', 'large day-night temperature swing'),
    'windy': ('風大', 'windy'),
    'dusty': ('沙塵多', 'dusty air'),
    'high_uv': ('紫外線強', 'strong ultraviolet'),
    'high_altitude': ('高海拔（低氣壓）', 'high altitude (thin air)'),
    'caves': ('喀斯特洞穴', 'karst caves'),
    'impact': ('靠近撞擊坑', 'near an impact structure'),
}

# region id -> (zh, en, list of boxes (lat_min, lat_max, lon_min, lon_max))
REGIONS = {
    'africa': ('非洲', 'Africa', [(-35, 37.5, -18, 52)]),
    'asia': ('亞洲', 'Asia', [(-11, 78, 26, 180)]),
    'europe': ('歐洲', 'Europe', [(35, 72, -25, 45)]),
    'north_america': ('北美洲', 'North America', [(7, 84, -170, -52)]),
    'south_america': ('南美洲', 'South America', [(-56, 13, -82, -34)]),
    'oceania': ('大洋洲', 'Oceania', [(-48, 0, 110, 180)]),
    'antarctica': ('南極', 'Antarctica', [(-90, -60, -180, 180)]),
    'arctic': ('北極圈', 'the Arctic', [(66.5, 90, -180, 180)]),
    'usa': ('美國', 'the United States', [(24, 50, -125, -66), (51, 72, -170, -129), (18.5, 22.5, -160.5, -154.5)]),
    'canada': ('加拿大', 'Canada', [(41.5, 84, -141, -52)]),
    'mexico': ('墨西哥', 'Mexico', [(14.5, 33, -118, -86)]),
    'chile': ('智利', 'Chile', [(-56, -17.5, -76, -66)]),
    'argentina': ('阿根廷', 'Argentina', [(-55, -21.5, -73.6, -53.6)]),
    'peru': ('秘魯', 'Peru', [(-18.4, 0, -81.4, -68.6)]),
    'bolivia': ('玻利維亞', 'Bolivia', [(-23, -9.6, -69.7, -57.4)]),
    'china': ('中國', 'China', [(18, 54, 73, 135)]),
    'mongolia': ('蒙古', 'Mongolia', [(41.5, 52.2, 87.7, 120)]),
    'india': ('印度', 'India', [(6.5, 35.7, 68, 97.5)]),
    'iran': ('伊朗', 'Iran', [(25, 40, 44, 63.5)]),
    'saudi_arabia': ('沙烏地阿拉伯', 'Saudi Arabia', [(16, 32.2, 34.5, 55.7)]),
    'egypt': ('埃及', 'Egypt', [(22, 31.7, 25, 36.9)]),
    'morocco': ('摩洛哥', 'Morocco', [(27.6, 35.9, -13.2, -1)]),
    'algeria': ('阿爾及利亞', 'Algeria', [(19, 37.1, -8.7, 12)]),
    'libya': ('利比亞', 'Libya', [(19.5, 33.2, 9.3, 25.2)]),
    'namibia': ('納米比亞', 'Namibia', [(-29, -17, 11.7, 25.3)]),
    'south_africa': ('南非', 'South Africa', [(-35, -22, 16.4, 32.9)]),
    'ethiopia': ('衣索比亞', 'Ethiopia', [(3.4, 15, 33, 48)]),
    'kenya': ('肯亞', 'Kenya', [(-4.7, 5.1, 33.9, 41.9)]),
    'iceland': ('冰島', 'Iceland', [(63.2, 66.6, -24.6, -13.4)]),
    'greenland': ('格陵蘭', 'Greenland', [(59.7, 83.7, -73.3, -11.3)]),
    'norway': ('挪威', 'Norway', [(57.9, 71.2, 4.5, 31.2), (76.4, 80.9, 10, 34)]),
    'russia': ('俄羅斯', 'Russia', [(41, 82, 27, 180)]),
    'kazakhstan': ('哈薩克', 'Kazakhstan', [(40.5, 55.5, 46.5, 87.4)]),
    'turkey': ('土耳其', 'Turkey', [(35.8, 42.1, 26, 44.8)]),
    'spain': ('西班牙', 'Spain', [(36, 43.8, -9.3, 3.3)]),
    'australia': ('澳洲', 'Australia', [(-44, -10, 112, 154)]),
    'new_zealand': ('紐西蘭', 'New Zealand', [(-47.3, -34.4, 166.4, 178.6)]),
    'japan': ('日本', 'Japan', [(24, 45.6, 123, 146)]),
    'taiwan': ('台灣', 'Taiwan', [(21.9, 25.3, 120, 122)]),
    'indonesia': ('印尼', 'Indonesia', [(-11, 6, 95, 141)]),
    'hawaii': ('夏威夷', 'Hawaii', [(18.5, 22.5, -160.5, -154.5)]),
    'sahara': ('撒哈拉', 'the Sahara', [(15, 33, -17, 35)]),
    'atacama': ('阿塔卡馬', 'the Atacama', [(-27.5, -18, -71, -68)]),
    'tibet': ('青藏高原', 'the Tibetan Plateau', [(27, 37, 78, 104)]),
    'gobi': ('戈壁', 'the Gobi', [(38, 46, 92, 115)]),
}

# target id -> (body, lat, lon, zh, en)
TARGETS = {
    'lunar_south_pole': ('moon', -89.5, 0.0, '月球南極', 'the lunar south pole'),
    'shackleton': ('moon', -89.7, 129.8, '沙克爾頓隕石坑', 'Shackleton crater'),
    'mare_tranquillitatis': ('moon', 8.5, 31.4, '靜海', 'Mare Tranquillitatis'),
    'apollo_11': ('moon', 0.67, 23.47, '阿波羅 11 號登陸點', 'the Apollo 11 site'),
    'apollo_15': ('moon', 26.1, 3.6, '阿波羅 15 號哈德利溪', 'the Apollo 15 Hadley Rille site'),
    'apollo_17': ('moon', 20.2, 30.8, '阿波羅 17 號陶拉斯-利特羅谷', 'the Apollo 17 Taurus-Littrow valley'),
    'marius_hills': ('moon', 13.4, -55.9, '馬利厄斯丘', 'the Marius Hills'),
    'aristarchus': ('moon', 23.7, -47.4, '阿里斯塔克斯高原', 'the Aristarchus plateau'),
    'copernicus': ('moon', 9.6, -20.1, '哥白尼隕石坑', 'Copernicus crater'),
    'mare_imbrium': ('moon', 32.8, -15.6, '雨海', 'Mare Imbrium'),
    'tranquillitatis_pit': ('moon', 8.34, 33.22, '靜海坑洞', 'the Mare Tranquillitatis pit'),
    'jezero': ('mars', 18.4, 77.5, '耶澤羅隕石坑', 'Jezero crater'),
    'gale': ('mars', -5.4, 137.8, '蓋爾隕石坑', 'Gale crater'),
    'utopia_planitia': ('mars', 46.7, 117.5, '烏托邦平原', 'Utopia Planitia'),
    'arcadia_planitia': ('mars', 47.2, -176.6, '阿卡迪亞平原', 'Arcadia Planitia'),
    'olympus_mons': ('mars', 18.65, -133.8, '奧林帕斯山', 'Olympus Mons'),
    'valles_marineris': ('mars', -13.9, -59.2, '水手號峽谷', 'Valles Marineris'),
    'meridiani': ('mars', -1.95, -5.5, '子午線高原', 'Meridiani Planum'),
    'hellas': ('mars', -42.4, 70.5, '希臘平原', 'Hellas Planitia'),
    'elysium': ('mars', 3.0, 154.7, '埃律西昂平原', 'Elysium Planitia'),
    'olympia_undae': ('mars', 81.4, 180.0, '奧林匹亞沙海（北極沙丘）', 'Olympia Undae (north polar dunes)'),
    'phlegra_montes': ('mars', 40.4, 163.7, '弗萊格拉山脈', 'Phlegra Montes'),
    'mawrth_vallis': ('mars', 22.6, -16.5, '馬沃斯谷', 'Mawrth Vallis'),
    'mars_north_pole': ('mars', 85.0, 0.0, '火星北極', 'the Martian north pole'),
}


def empty():
    return {'target': None, 'body': None, 'conditions': {}, 'region': None, 'exclude_regions': [], 'exclude_known': False,
            'top_k': DEFAULT_TOP_K}


def canonical(spec):
    """Key order and value order fixed, so a spec has exactly one text form (what the model is trained to write)."""
    s = empty()
    s.update({k: v for k, v in spec.items() if k in s})
    s['conditions'] = {k: s['conditions'][k] for k in CONDITIONS if k in s['conditions']}
    s['exclude_regions'] = [r for r in REGIONS if r in s['exclude_regions']]
    return s


def dumps(spec):
    return json.dumps(canonical(spec), ensure_ascii=False, separators=(',', ':'))


def validate(spec):
    """Return a clean spec or raise ValueError; anything outside the vocabularies is rejected."""
    if not isinstance(spec, dict):
        raise ValueError('spec is not an object')
    s = canonical(spec)
    if s['target'] is not None and s['target'] not in TARGETS:
        raise ValueError(f"unknown target {s['target']!r}")
    if s['body'] not in (None, 'moon', 'mars'):
        raise ValueError(f"unknown body {s['body']!r}")
    if s['target'] is not None:
        s['body'] = TARGETS[s['target']][0]
    if not isinstance(s['conditions'], dict) or any(c not in CONDITIONS or v not in IMPORTANCE for c, v in s['conditions'].items()):
        raise ValueError('bad conditions')
    if s['region'] is not None and s['region'] not in REGIONS:
        raise ValueError(f"unknown region {s['region']!r}")
    if not isinstance(s['exclude_regions'], list) or any(r not in REGIONS for r in s['exclude_regions']):
        raise ValueError('bad exclude_regions')
    s['exclude_known'] = bool(s['exclude_known'])
    if s['top_k'] not in TOP_K:
        s['top_k'] = min(TOP_K, key=lambda k: abs(k - int(s['top_k'] or DEFAULT_TOP_K)))
    return canonical(s)


def salvage(spec):
    """Like validate, but drop only the parts outside the vocabularies (e.g. an invented target name) and keep the rest.
    Returns (clean spec, list of dropped parts). Raises ValueError only if spec is not an object."""
    if not isinstance(spec, dict):
        raise ValueError('spec is not an object')
    s = dict(spec)
    dropped = []
    if s.get('target') is not None and s.get('target') not in TARGETS:
        dropped.append(f"target {s['target']!r}"); s['target'] = None
    if s.get('body') not in (None, 'moon', 'mars'):
        dropped.append(f"body {s['body']!r}"); s['body'] = None
    conds = s.get('conditions') if isinstance(s.get('conditions'), dict) else {}
    keep = {c: v for c, v in conds.items() if c in CONDITIONS and v in IMPORTANCE}
    dropped += [f'condition {c!r}' for c in conds if c not in keep]
    s['conditions'] = keep
    if s.get('region') is not None and s.get('region') not in REGIONS:
        dropped.append(f"region {s['region']!r}"); s['region'] = None
    ex = s.get('exclude_regions') if isinstance(s.get('exclude_regions'), list) else []
    s['exclude_regions'] = [r for r in ex if r in REGIONS]
    dropped += [f'exclude {r!r}' for r in ex if r not in REGIONS]
    try:
        int(s.get('top_k') or DEFAULT_TOP_K)
    except (TypeError, ValueError):
        s['top_k'] = DEFAULT_TOP_K
    return validate(s), dropped


CHAT_TEXT = '{"chat":true}'   # what the v2 model writes for small talk (no search, spec unchanged)


def parse_output(text, previous):
    """Model text -> ('chat', previous) | ('spec', spec) | ('error', previous). Out-of-vocabulary parts are dropped."""
    i, j = text.find('{'), text.rfind('}')
    try:
        obj = json.loads(text[i:j + 1])
    except Exception:  # noqa: BLE001
        return 'error', previous
    if isinstance(obj, dict) and obj.get('chat') is True:
        return 'chat', previous
    try:
        return 'spec', validate(obj)
    except Exception:  # noqa: BLE001
        pass
    try:
        return 'spec', salvage(obj)[0]
    except Exception:  # noqa: BLE001
        return 'error', previous


FOLLOW_CUES = ('也要', '再加', '還要', '另外', '加上', '順便', '同時', 'also', 'add ', 'plus', 'as well', 'too')


def is_blank(spec):
    return not (spec['target'] or spec['body'] or spec['conditions'] or spec['region'] or spec['exclude_regions'] or spec['exclude_known'])


EXCLUDE_CUES = ('不要', '排除', '除了', '以外', '之外', '不含', 'not ', 'except', 'exclude', 'outside', 'without', 'no ')


SEARCH_WORDS = (
    # what / where
    '找', '哪', '地方', '地點', '環境', '地形', '場址', '類比', '區域', '像', '類似', '推薦', '搜尋',
    'find', 'where', 'place', 'site', 'analog', 'terrain', 'environment', 'like', 'similar', 'search', 'show', 'somewhere',
    # bodies and targets
    '月球', '火星', '月面', '撞擊坑', '隕石坑', '極', '高地', '盆地', '峽谷', '熔岩管', 'moon', 'lunar', 'mars', 'martian',
    'crater', 'pole', 'polar', 'highland', 'basin', 'valley', 'tube',
    # condition words
    '乾', '冷', '熱', '冰', '雪', '凍', '沙', '丘', '鹽', '黏土', '玄武', '火山', '熔岩', '岩', '石', '平', '崎嶇', '陡', '山',
    '路', '偏遠', '沙漠', '荒', '植', '雨', '太陽', '日照', '沉積', '蒸發',
    'dry', 'arid', 'desert', 'cold', 'hot', 'ice', 'icy', 'snow', 'frozen', 'permafrost', 'sand', 'dune', 'salt', 'clay',
    'basalt', 'volcan', 'lava', 'rock', 'flat', 'rough', 'rugged', 'steep', 'mountain', 'road', 'remote', 'access', 'bare',
    'vegetation', 'rain', 'sun', 'sediment', 'evaporite', 'anorthosite',
    # follow-up commands
    '多', '少', '不要', '排除', '只要', '改', '換', '加', '移除', '去掉', '取消', '必須', '最好', '避開', '可有可無', '已知', '筆', '個',
    'more', 'fewer', 'less', 'remove', 'drop', 'only', 'switch', 'change', 'add', 'exclude', 'avoid', 'must', 'prefer',
    'known', 'results', 'instead',
)


def looks_like_search(message):
    """False for greetings and small talk ("嗨你好", "thanks"): nothing about places, conditions, targets or follow-up changes.
    The model was trained only on search requests, so it would invent conditions for these."""
    m = message.lower()
    if any(w in m for w in SEARCH_WORDS):
        return True
    if any(zh in message or en.lower() in m for zh, en, _ in REGIONS.values()) or any(k.replace('_', ' ') in m for k in REGIONS):
        return True
    words = {w for t in TARGETS.values() for w in t[4].lower().replace('(', ' ').replace(')', ' ').split() if len(w) >= 5}
    words |= {w for k in TARGETS for w in k.split('_') if len(w) >= 5}
    if any(w in m for w in words):
        return True
    return any(t[3] in message or t[4].lower() in m for t in TARGETS.values())


def small_talk_reply(zh, has_results):
    if zh:
        return ('我只負責找地球上的類比地點。請描述想要的條件，例如「像月球南極那樣又冷又乾的地方」「冰島的玄武岩熔岩地形」「火星上有黏土的乾燥地方」。'
                + ('目前的結果保留不變，也可以接著說「改成火星」「不要非洲」「多給幾個」。' if has_results else ''))
    return ('I only search for Earth analog sites. Describe the conditions you need, for example "cold and dry like the lunar south pole", '
            '"basalt lava fields in Iceland" or "dry clay-rich places for Mars".'
            + (' The current results stay; you can also say "switch to Mars", "not Africa" or "show more".' if has_results else ''))


def literal_region(message):
    """A region named outright in the message (zh or en name, or key), when exactly one is named and not as an exclusion."""
    for t in TARGETS.values():  # 「月球南極」 names a target, not Antarctica
        message = message.replace(t[3], ' ').replace(t[4], ' ')
    for w in ('月球南極', '月球北極', '火星南極', '火星北極', '南極冠', '北極冠', 'lunar south pole', 'lunar north pole',
              'polar cap', 'polar dunes', 'south pole of the moon', 'north pole of mars'):
        message = message.replace(w, ' ').replace(w.title(), ' ')
    m = message.lower()
    if any(c in m for c in EXCLUDE_CUES):
        return None
    hits = [k for k, (zh, en, _) in REGIONS.items() if zh in message or en.lower() in m or k.replace('_', ' ') in m]
    hits = [k for k in hits if not any(k != o and REGIONS[k][1].lower() in REGIONS[o][1].lower() for o in hits)]
    return hits[0] if len(hits) == 1 else None


def apply_literal_region(spec, message):
    r = literal_region(message)
    if r and spec['region'] is None:
        spec = dict(spec, region=r, exclude_regions=[x for x in spec['exclude_regions'] if x != r])
    return validate(spec)


def merge_turn(prev, ctx, fresh, message):
    """Combine two readings of one message (2026-11-12 fix: the 1B model tends to keep the first turn's target forever).
    prev: spec before this turn; ctx: model output given prev; fresh: model output for the message alone.
    Returns (spec, mode) with mode 'new' (a complete new request starts over) or 'update'."""
    if is_blank(prev):
        return ctx, 'new'
    m = message.lower()
    follow = any(c in m for c in FOLLOW_CUES)
    place = fresh['target'] or fresh['body'] or fresh['region']
    if not follow and place and fresh['conditions']:
        return fresh, 'new'          # read alone it names a place and conditions: a new search
    if fresh['target'] and fresh['target'] != prev['target']:
        return fresh, 'new'          # a different named target is a new search
    out = canonical(ctx)
    prev_body = TARGETS[prev['target']][0] if prev['target'] else prev['body']
    if fresh['body'] and fresh['body'] != prev_body:   # e.g. 「改成火星」
        out['body'], out['target'] = fresh['body'], None
    if fresh['region']:
        out['region'] = fresh['region']
        out['exclude_regions'] = [r for r in out['exclude_regions'] if r != fresh['region']]
    for r in fresh['exclude_regions']:
        if r not in out['exclude_regions']:
            out['exclude_regions'].append(r)
        if out['region'] == r:
            out['region'] = None
    conds = dict(out['conditions'])
    for c, v in fresh['conditions'].items():
        if c in prev['conditions'] and c not in ctx['conditions']:
            continue                 # the follow-up reading removed it; do not put it back
        if c in ctx['conditions'] and ctx['conditions'][c] != prev['conditions'].get(c):
            continue                 # the follow-up reading already changed it
        conds[c] = v
    out['conditions'] = conds
    if fresh['top_k'] != DEFAULT_TOP_K:
        out['top_k'] = fresh['top_k']
    if fresh['exclude_known']:
        out['exclude_known'] = True
    return validate(out), 'update'


def carries_over(prev, spec):
    """True when the new spec keeps something the user set before (a follow-up), False for a fresh request."""
    if spec == prev:
        return True
    return bool((prev['target'] and spec['target'] == prev['target'])
                or any(spec['conditions'].get(c) == v for c, v in prev['conditions'].items())
                or (prev['region'] and spec['region'] == prev['region'])
                or any(r in spec['exclude_regions'] for r in prev['exclude_regions'])
                or (prev['exclude_known'] and spec['exclude_known']) or (prev['top_k'] != DEFAULT_TOP_K and spec['top_k'] == prev['top_k']))


def change_text(prev, spec, mode, zh):
    """One short line saying what this turn changed, shown before the result summary."""
    name_c = lambda c: CONDITIONS[c][0 if zh else 1]
    name_r = lambda r: REGIONS[r][0 if zh else 1]
    imp = {'must': ('必須', 'must'), 'prefer': ('最好', 'prefer'), 'avoid': ('避開', 'avoid')}
    if mode == 'new':
        return '新的搜尋。' if zh else 'New search.'
    parts = []
    pb = TARGETS[prev['target']][0] if prev['target'] else prev['body']
    nb = TARGETS[spec['target']][0] if spec['target'] else spec['body']
    if nb != pb:
        parts.append(('目標改為' + {'moon': '月球', 'mars': '火星'}.get(nb, '不限')) if zh else f'target now {nb or "any body"}')
    for c, v in spec['conditions'].items():
        if prev['conditions'].get(c) != v:
            parts.append((f'{name_c(c)}改為{imp[v][0]}' if c in prev['conditions'] else f'加入{name_c(c)}（{imp[v][0]}）') if zh
                         else f'{name_c(c)} → {imp[v][1]}')
    for c in prev['conditions']:
        if c not in spec['conditions']:
            parts.append(f'移除{name_c(c)}' if zh else f'removed {name_c(c)}')
    if spec['region'] != prev['region']:
        parts.append((f'範圍：{name_r(spec["region"])}' if spec['region'] else '不限地區') if zh
                     else (f'region: {name_r(spec["region"])}' if spec['region'] else 'any region'))
    for r in spec['exclude_regions']:
        if r not in prev['exclude_regions']:
            parts.append(f'排除{name_r(r)}' if zh else f'excluding {name_r(r)}')
    if spec['top_k'] != prev['top_k']:
        parts.append(f'改為 {spec["top_k"]} 筆' if zh else f'{spec["top_k"]} results')
    if spec['exclude_known'] != prev['exclude_known']:
        parts.append(('排除已知場址' if spec['exclude_known'] else '包含已知場址') if zh else ('excluding known sites' if spec['exclude_known'] else 'including known sites'))
    if not parts:
        return '條件沒有變動。' if zh else 'No change to the conditions.'
    return ('這次更新：' + '、'.join(parts) + '。') if zh else ('Updated: ' + ', '.join(parts) + '.')


SYSTEM = ('You turn a request for Earth analog sites of the Moon or Mars into a search spec. '
          'Reply with one JSON object only, using the keys target, body, conditions, region, exclude_regions, exclude_known, top_k. '
          'Update the previous spec with the new message; keep everything the message does not change.')


def prompt_messages(previous, message):
    return [{'role': 'system', 'content': SYSTEM},
            {'role': 'user', 'content': f'PREVIOUS: {dumps(previous or empty())}\nMESSAGE: {message}'}]
