"""One prompt format for generation, training and serving of the TwinGround assistant (2026-11-14)."""
import re

SYSTEM = {
    'zh': ('你是 TwinGround 網站的小助手（NASA Space Apps 2026，題目：找出與月球永久基地及火星相似的地球地點）。'
           '你回答關於 TwinGround 的問題：網站怎麼用、方法與結果（論文〈The Earth Ceiling〉）、使用的資料，以及某個候選地點為什麼被選中。'
           '只能根據下面編號的「資料」與「[SITE] 搜尋結果」回答，引用資料時標註 [1]、[2]。'
           '資料裡沒有答案就直接說不知道，並建議去網站哪裡看；絕對不要編造數字或來源。'
           '分數是排序分數，不是機率；候選地點是篩選結果，不是已驗證的類比地。用繁體中文、簡潔回答。'),
    'en': ('You are the assistant on the TwinGround website (NASA Space Apps 2026: identify Earth locations that are analogs of '
           'permanent Moon base locations and Mars). You answer questions about TwinGround: how to use the site, its method and '
           'results (the paper "The Earth Ceiling"), the data it uses, and why a candidate site was selected. '
           'Answer only from the numbered SOURCES and the [SITE] search result below, and cite sources as [1], [2]. '
           'If they do not contain the answer, say you do not know and suggest where on the site to look; never invent numbers '
           'or sources. Scores are ranking scores, not probabilities; candidates are screening results, not verified analogs. '
           'Answer in English, concisely.'),
}


def context_block(passages, site=None, lang='en'):
    zh = lang == 'zh'
    lines = ['資料：' if zh else 'SOURCES:']
    for i, p in enumerate(passages, 1):
        head = p.get('title', '')
        if p.get('section') and p['section'] not in ('citation', 'full text'):
            head += ' — ' + p['section']
        lines.append(f'[{i}] {head}\n{p["text"]}')
    if not passages:
        lines.append('（無）' if zh else '(none)')
    if site:
        lines.append('\n' + site)
    return '\n'.join(lines)


def system_message(passages, site=None, lang='en'):
    return SYSTEM['zh' if lang == 'zh' else 'en'] + '\n\n' + context_block(passages, site, lang)


def messages(history, passages, site=None, lang='en'):
    """history: [{"role": "user"|"assistant", "content": str}, ...] ending with the user turn."""
    return [{'role': 'system', 'content': system_message(passages, site, lang)}] + list(history)


def detect_lang(text):
    return 'zh' if re.search(r'[一-鿿]', text or '') else 'en'


def cited(answer, n):
    """Citation numbers used in an answer; None if any is out of range."""
    nums = [int(x) for x in re.findall(r'\[(\d{1,2})\]', answer)]
    return None if any(x < 1 or x > n for x in nums) else sorted(set(nums))


SIMPLIFIED_ONLY = set('这们说发实时对从为么过还应样进关当两点现数据个经将让给运问题区图东车门见长马鸟鱼头')


def looks_simplified(text):
    return sum(ch in SIMPLIFIED_ONLY for ch in text) >= 2
