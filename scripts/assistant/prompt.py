"""One prompt format for generation, training and serving of the TwinGround assistant (2026-11-14)."""
import re

SYSTEM = {
    'zh': ('你是 TwinGround 網站的小助手。TwinGround 在地球上找出實測地形與條件跟使用者選的月球或火星地點相似的地方，'
           '比較兩者，並讓使用者在 3D 中走在兩邊的地表上（NASA Space Apps 2026 參賽作品）。'
           '你回答關於 TwinGround 的問題：網站怎麼用、方法與結果（論文〈The Earth Ceiling〉）、使用的資料，以及某個候選地點為什麼被選中。'
           '只能根據下面編號的「資料」與「[SITE] 搜尋結果」回答，引用資料時標註 [1]、[2]。'
           '只說資料裡寫的事，不要自己補上原因、用途或重要性。資料集要寫出資料裡標明的機構，不是每個資料都是 NASA 的。'
           '資料裡沒有答案就直接說不知道，並建議去網站哪裡看；絕對不要編造數字或來源。'
           '問題與 TwinGround、月球、火星或地球類比地無關時，簡短說明你只回答 TwinGround 的問題，不要引用任何資料。'
           '分數是排序分數，不是機率；候選地點是篩選結果，不是已驗證的類比地。用繁體中文、簡潔回答。'),
    'en': ('You are the assistant on the TwinGround website. TwinGround finds places on Earth whose measured terrain and '
           'conditions resemble a site the user chooses on the Moon or Mars, compares them, and lets the user walk both '
           'surfaces in 3D (an entry to NASA Space Apps 2026). You answer questions about TwinGround: how to use the site, its method and '
           'results (the paper "The Earth Ceiling"), the data it uses, and why a candidate site was selected. '
           'Answer only from the numbered SOURCES and the [SITE] search result below, and cite sources as [1], [2]. '
           'Say only what the sources say; do not add reasons, uses or importance they do not state. Name the agency a source '
           'gives for each dataset; not every dataset is NASA data. '
           'If they do not contain the answer, say you do not know and suggest where on the site to look; never invent numbers '
           'or sources. If the question is not about TwinGround, the Moon, Mars or Earth analogs, say briefly that you only '
           'answer questions about TwinGround, and cite nothing. '
           'Scores are ranking scores, not probabilities; candidates are screening results, not verified analogs. '
           'Answer in English, concisely.'),
}
# Added to the system message when the request carries no candidate brief (the "Include the current candidate" box is
# unticked, or no search is open): earlier answers about a candidate must not be reused as if they were sources.
NO_SITE = {
    'zh': '目前沒有選取候選地點：不要陳述任何特定候選地點的分數或性質，也不要沿用先前對話中關於候選地點的內容。',
    'en': ('No candidate is selected for this question: do not state scores or properties of any particular candidate '
           'site, and do not reuse earlier answers about a candidate.'),
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


def system_message(passages, site=None, lang='en', no_site_note=False):
    lang = 'zh' if lang == 'zh' else 'en'
    note = ('\n' + NO_SITE[lang]) if no_site_note and not site else ''
    return SYSTEM[lang] + note + '\n\n' + context_block(passages, site, lang)


def messages(history, passages, site=None, lang='en', no_site_note=False):
    """history: [{"role": "user"|"assistant", "content": str}, ...] ending with the user turn.
    no_site_note: serving only (training never set it); adds NO_SITE when there is no [SITE] brief."""
    return [{'role': 'system', 'content': system_message(passages, site, lang, no_site_note)}] + list(history)


# --- post-processing of generated answers (serving) ---------------------------------------------------------------
CANDIDATE_TAG = {'en': '[candidate]', 'zh': '[候選]'}
SITE_PHRASES = [  # "the [SITE] search result" reads badly once [SITE] becomes a citation chip
    (re.compile(r'\b(?:the|this)\s+\[SITE\]\s+(?:search\s+)?(?:results?|brief|data)\b', re.I), 'the search result for this candidate'),
    (re.compile(r'\[SITE\]\s*(?:的)?\s*搜尋結果'), '候選地點的搜尋結果'),
]
REFUSAL = re.compile(r"(I (?:do not|don't) know|I could not find|找不到答案|I only answer|only (?:help|answer) (?:with )?questions about TwinGround|"
                     r"I'm here to help with questions about TwinGround|not (?:able|related) to|outside (?:the scope|what)|"
                     r"不知道|只回答|無法回答|與 ?TwinGround 無關)", re.I)


def tidy_answer(text, n_sources, has_site, lang='en'):
    """Make a generated answer safe to show.

    - citation numbers outside 1..n_sources are removed;
    - the internal [SITE] tag becomes a readable candidate citation ([candidate] / [候選]) when a brief was given, and
      is removed otherwise;
    - phrases left empty by a removed citation ("According to , …", "根據 ，…", "as described in .") are repaired;
    - spacing around punctuation is normalised.
    Returns (text, cited source numbers)."""
    lang = 'zh' if lang == 'zh' else 'en'
    text = re.sub(r'\[(\d{1,2})\]', lambda m: m.group(0) if 1 <= int(m.group(1)) <= n_sources else '', text)
    text = re.sub(r'\[\s*(?:SOURCE|SOURCES|資料)\s*\]', '', text, flags=re.I)
    if has_site:
        for pat, rep in SITE_PHRASES:
            text = pat.sub(rep, text)
        text = re.sub(r'\[\s*SITE\s*\]', CANDIDATE_TAG[lang], text, flags=re.I)
        tag = re.escape(CANDIDATE_TAG[lang])
        text = re.sub(rf'(?:{tag}\s*){{2,}}', CANDIDATE_TAG[lang] + ' ', text)  # one tag per spot
    else:
        text = re.sub(r'\b(?:the|this)\s+\[SITE\]\s+(?:search\s+)?(?:results?|brief|data)\b', 'the sources', text, flags=re.I)
        text = re.sub(r'\[\s*SITE\s*\]', '', text, flags=re.I)
    # Lead-ins whose citation was removed: "According to , X" -> "X"; "根據 ，X" -> "X".
    text = re.sub(r'(?i)\b(?:according to|based on|as (?:described|stated|shown|reported) in)\s*[,:;]\s*', '', text)
    text = re.sub(r'(?im)^(\s*)(?:per|from)\s*[,:;]\s*', r'\1', text)
    text = re.sub(r'(?m)(^|[。！？\n]\s*)(?:根據|依據|依照|參考|如)\s*[，,、：:]\s*', r'\1', text)
    text = re.sub(r'(?i)[,;]?\s*\b(?:according to|as (?:described|stated|shown|reported|cited) in|see)\s*(?=[.。,;)]|$)', '', text)
    text = re.sub(r'(?:根據|依據|參考|見)\s*(?=[。，；）])', '', text)
    text = re.sub(r'\(\s*[,;]?\s*\)|（\s*[，、]?\s*）|\[\s*\]', '', text)
    # sentences emptied by a removed citation ("as stated in [9]." -> ".", "0.75. [9]. Next" -> "0.75. Next")
    text = re.sub(r'(?:^\s*|(?<=[.!?。！？])\s+)[.,;:。，；：]+(?=\s|$)', '', text)
    text = re.sub(r'[ \t]+([,.;:!?。，；：！？)])', r'\1', text)
    text = re.sub(r'[ \t]{2,}', ' ', text)
    text = re.sub(r'(?m)^[ \t]+|[ \t]+$', '', text).strip()
    if text[:1].islower():
        text = text[0].upper() + text[1:]
    return text, sorted(set(int(x) for x in re.findall(r'\[(\d{1,2})\]', text)))


def looks_refusal(text):
    return bool(REFUSAL.search(text or ''))


def detect_lang(text):
    return 'zh' if re.search(r'[一-鿿]', text or '') else 'en'


def cited(answer, n):
    """Citation numbers used in an answer; None if any is out of range."""
    nums = [int(x) for x in re.findall(r'\[(\d{1,2})\]', answer)]
    return None if any(x < 1 or x > n for x in nums) else sorted(set(nums))


SIMPLIFIED_ONLY = set('这们说发实时对从为么过还应样进关当两点现数据个经将让给运问题区图东车门见长马鸟鱼头')


def looks_simplified(text):
    return sum(ch in SIMPLIFIED_ONLY for ch in text) >= 2
