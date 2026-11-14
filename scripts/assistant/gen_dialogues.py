"""Generate grounded training dialogues for the TwinGround assistant with a teacher model (2026-11-14).

Runs on the GPU node:  python gen_dialogues.py --teacher ~/models/llama70b --e5 ~/models/e5 --work ~/work
Inputs in --work: chunks.jsonl (RAG corpus), site_cases.jsonl (briefs of real search results).
Output: --work/dialogues.jsonl, one {"messages": [...], "type", "lang"} per line, in the exact prompt format the student
sees at serving time (prompt.messages). Teacher: Meta Llama 3.3 70B Instruct, served offline by vLLM.

Types: doc (questions answered from the paper, SI, brief, site text and cited works), site (why a real candidate was chosen,
what fails, comparisons), off (out of scope or unanswerable: the answer declines or redirects), followup (second turn).
Every answer is written by the teacher from the same retrieved SOURCES the student will get; when the passage that
prompted a question is not retrieved (kept missing on purpose for ~15 % of questions), the right answer is to say so.
"""
import argparse
import json
import random
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import prompt as P  # noqa: E402
from rag import Index  # noqa: E402

PERSONAS = {
    'zh': ['高中生', '大學地科系學生', '月球任務規劃師', 'NASA Space Apps 評審', '行星地質研究生', '對太空有興趣的一般民眾',
           '科學記者', '想做 ISRU 實驗的工程師', '太空人訓練教官', '地理老師'],
    'en': ['high-school student', 'geology undergraduate', 'lunar mission planner', 'NASA Space Apps judge',
           'planetary geology PhD student', 'curious member of the public', 'science journalist',
           'ISRU engineer', 'astronaut training instructor', 'teacher preparing a class'],
}
SITE_INTENTS = {
    'zh': ['為什麼選這個地點', '這個候選哪些面向不符合、差在哪裡', '為什麼分數不是 100', '它和其他候選比起來如何',
           '這裡適不適合做 ISRU 原料實驗', '這裡適合測試月球車或火星車嗎', '地球上限是什麼意思，這裡離上限多遠',
           '有哪些條件是地球上根本做不到的', '這裡是已知的類比地嗎', '去這裡做野外測試方便嗎', '這裡的岩性跟目標像不像',
           '溫度方面差多少', '用一句話總結這個地點'],
    'en': ['why this site was chosen', 'which facets of this candidate fail and by how much', 'why the score is not 100',
           'how it compares with the other candidates', 'whether it suits an ISRU feedstock test', 'whether it suits rover testing',
           'what the Earth ceiling means here and how far this site is from it', 'what Earth cannot reproduce at all',
           'whether this is a known analog site', 'how easy it is to reach for field work', 'whether its rock type matches the target',
           'how different the temperatures are', 'a one-sentence summary of the site'],
}
OFF_THEMES = ['today\'s weather', 'writing someone\'s homework essay', 'stock tips', 'a recipe', 'a politics question',
              'medical advice', 'how to hack a website', 'a joke', 'who will win a sports game', 'the user\'s password',
              'a question about Jupiter\'s moons that TwinGround does not cover', 'the exact cost of an Artemis launch',
              'whether aliens live on Mars', 'a greeting', 'thanks and goodbye', 'what the assistant is', 'translating a poem',
              'the opening hours of NASA visitor centers', 'a coding bug in an unrelated project', 'details of a Moon site never searched']
LANG_NAME = {'zh': '繁體中文（台灣用語，絕對不要用簡體字）', 'en': 'English'}
TEACHER_GUIDE = {
    'zh': ('【給老師模型的指示，不會出現在學生訓練資料】請寫出理想答案：先直接回答，再用 2–6 句或簡短條列說明；'
           '每個事實都標註來源：編號資料用 [n]，來自 [SITE] 搜尋結果的內容用 [SITE]（沒有 [SITE] 時絕對不要說「搜尋結果顯示」）；'
           '解釋候選地點時，說清楚哪些面向符合、哪些不符合、差多少，以及地球上限與地球做不到的條件；'
           '資料不足就說不知道，並建議去網站哪一頁看；與 TwinGround 無關或不安全的要求（入侵、作業代寫、醫療、投資等）要禮貌拒絕，並說明你可以幫什麼。不要說「根據資料」以外的客套話，不要超過 220 字。'),
    'en': ('[Guide for the teacher only; not part of the student data] Write the ideal answer: answer directly first, then explain '
           'in 2–6 sentences or a short list; cite numbered sources as [n] and facts from the [SITE] search result as [SITE] (never mention a search result '
           'when there is no [SITE]); when explaining a candidate, say which facets hold, which fail and by how much, plus the Earth ceiling and what '
           'Earth cannot reproduce; if the sources are insufficient, say you do not know and point to the right page of the site; politely decline requests unrelated to TwinGround or unsafe '
           '(hacking, homework, medical, investment) and say what you can help with. '
           'No filler, at most 170 words.'),
}


def chat(llm, convs, temp, max_tokens, seed):
    from vllm import SamplingParams
    sp = SamplingParams(temperature=temp, top_p=0.95, max_tokens=max_tokens, seed=seed)
    outs = llm.chat(convs, sp, use_tqdm=True)
    return [o.outputs[0].text.strip() for o in outs]


def clean_q(q):
    q = q.strip().strip('"「」').split('\n')[0].strip()
    q = re.sub(r'^.{0,60}?(可能會問|會問|might ask|would ask)[^:：]{0,20}[:：]\s*', '', q)
    return re.sub(r'^(問題|Question)\s*[:：]\s*', '', q).strip().strip('"「」')


def good_answer(ans, lang, n_src, has_site=False):
    if not (40 <= len(ans) <= 1500):
        return False
    if P.cited(ans, n_src) is None:
        return False
    if lang == 'zh' and (len(re.findall(r'[一-鿿]', ans)) < 0.3 * len(ans) or P.looks_simplified(ans)):
        return False
    if lang == 'en' and re.search(r'[一-鿿]', ans):
        return False
    if re.search(r'(teacher|老師模型|給老師)', ans, re.I):
        return False
    if not has_site and re.search(r'(搜尋結果顯示|this search result|\[SITE\])', ans, re.I):
        return False
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--teacher', required=True)
    ap.add_argument('--e5', required=True)
    ap.add_argument('--work', required=True)
    ap.add_argument('--n-doc', type=int, default=5800)
    ap.add_argument('--n-site', type=int, default=4200)
    ap.add_argument('--n-off', type=int, default=900)
    ap.add_argument('--n-follow', type=int, default=2400)
    ap.add_argument('--tp', type=int, default=8)
    a = ap.parse_args()
    work = Path(a.work).expanduser()
    rnd = random.Random(2026)
    t0 = time.time()

    index = Index.build(work / 'chunks.jsonl', a.e5, device='cpu')  # keep CUDA untouched for vLLM workers
    chunks = index.chunks
    own = [c for c in chunks if c['source'] == 'own']
    full = [c for c in chunks if c['source'] == 'ref' and c['doc'] != 'citation']
    cites = [c for c in chunks if c['doc'] == 'citation']
    cases = [json.loads(l) for l in (work / 'site_cases.jsonl').open(encoding='utf-8')]
    print(len(chunks), 'passages,', len(cases), 'site briefs', flush=True)

    from vllm import LLM
    llm = LLM(model=str(Path(a.teacher).expanduser()), tensor_parallel_size=a.tp, max_model_len=8192,
              gpu_memory_utilization=0.90, enable_prefix_caching=True)

    # ---- stage 1: questions
    items = []
    for _ in range(a.n_doc):
        r = rnd.random()
        seed = rnd.choice(own if r < 0.8 or not full else (full if r < 0.95 or not cites else cites))
        lang = 'zh' if rnd.random() < 0.6 else 'en'
        items.append({'type': 'doc', 'lang': lang, 'seed': seed, 'persona': rnd.choice(PERSONAS[lang])})
    for case in rnd.sample(cases, min(a.n_site, len(cases))):
        items.append({'type': 'site', 'lang': case['lang'], 'case': case,
                      'intent': rnd.choice(SITE_INTENTS[case['lang']])})
    for _ in range(a.n_off):
        lang = 'zh' if rnd.random() < 0.6 else 'en'
        items.append({'type': 'off', 'lang': lang, 'theme': rnd.choice(OFF_THEMES)})
    convs = []
    for it in items:
        L = LANG_NAME[it['lang']]
        if it['type'] == 'doc':
            convs.append([{'role': 'user', 'content':
                           f"Below is a passage from the TwinGround website, its research paper or a work the paper cites.\n\n"
                           f"PASSAGE ({it['seed']['title']} — {it['seed']['section']}):\n{it['seed']['text']}\n\n"
                           f"Write ONE question that a {it['persona']} using the TwinGround website might ask and that this passage "
                           f"answers. Make it natural and specific (no 'according to the passage'). Language: {L}. "
                           f"Output only the question."}])
        elif it['type'] == 'site':
            convs.append([{'role': 'user', 'content':
                           f"A user of the TwinGround website is looking at this search result:\n\n{it['case']['brief']}\n\n"
                           f"Write ONE question the user might ask the site's assistant about candidate #{it['case']['index'] + 1}, "
                           f"about: {it['intent']}. Sound like a real user typing in a chat box (short, may say 'this site' / '這個地點'). "
                           f"Language: {L}. Output only the question."}])
        else:
            convs.append([{'role': 'user', 'content':
                           f"Write ONE message a visitor might type into the chat assistant of a NASA Space Apps science website "
                           f"(TwinGround, about Earth analogs of the Moon and Mars). Theme: {it['theme']}. Language: {L}. "
                           f"Output only the message."}])
    qs = chat(llm, convs, 0.9, 120, 1)
    for it, q in zip(items, qs):
        it['q'] = clean_q(q)
    items = [it for it in items if 4 <= len(it['q']) <= 300]
    print('questions', len(items), f'{time.time() - t0:.0f}s', flush=True)

    # ---- stage 2: retrieval (the student's view)
    qv = index.embed_queries([it['q'] for it in items])
    for it, v in zip(items, qv):
        if it['type'] == 'site':
            it['src'] = index.search_vec(v, it['q'], k=2, max_chars=1400, prefer_lang=it['lang'])
            it['site'] = it['case']['brief']
        else:
            it['src'] = index.search_vec(v, it['q'], k=4, max_chars=2600, prefer_lang=it['lang'])
            it['site'] = None
            if it['type'] == 'doc' and all(s['id'] != it['seed']['id'] for s in it['src']) and rnd.random() < 0.85:
                it['src'][rnd.randrange(len(it['src']))] = it['seed']

    # ---- stage 3: answers
    def teacher_conv(it, history):
        msgs = P.messages(history, it['src'], it['site'], it['lang'])
        msgs[0] = {'role': 'system', 'content': TEACHER_GUIDE[it['lang']] + '\n\n' + msgs[0]['content']}
        return msgs

    ans = chat(llm, [teacher_conv(it, [{'role': 'user', 'content': it['q']}]) for it in items], 0.4, 600, 2)
    done = []
    for it, x in zip(items, ans):
        if good_answer(x, it['lang'], len(it['src']), bool(it['site'])):
            it['a'] = x
            done.append(it)
    print('answers kept', len(done), 'of', len(items), f'{time.time() - t0:.0f}s', flush=True)

    # ---- stage 4: follow-ups
    fol = rnd.sample([d for d in done if d['type'] != 'off'], min(a.n_follow, len(done)))
    fq = chat(llm, [[{'role': 'user', 'content':
                      f"Conversation on the TwinGround website assistant:\nUSER: {d['q']}\nASSISTANT: {d['a']}\n\n"
                      f"Write the user's natural follow-up question (short, may refer back with 'it' / '那'). "
                      f"Language: {LANG_NAME[d['lang']]}. Output only the question."}] for d in fol], 0.9, 100, 3)
    fv = index.embed_queries([d['q'] + ' ' + clean_q(q) for d, q in zip(fol, fq)])
    follow = []
    for d, q, v in zip(fol, fq, fv):
        f = dict(d, q2=clean_q(q))
        f['src2'] = index.search_vec(v, f['q2'], k=2 if d['type'] == 'site' else 4,
                                     max_chars=1400 if d['type'] == 'site' else 2600, prefer_lang=d['lang'])
        follow.append(f)

    def conv2(f):
        it = dict(f, src=f['src2'])
        return teacher_conv(it, [{'role': 'user', 'content': f['q']}, {'role': 'assistant', 'content': f['a']},
                                 {'role': 'user', 'content': f['q2']}])
    a2 = chat(llm, [conv2(f) for f in follow], 0.4, 600, 4)

    # ---- write student-format dialogues
    out = work / 'dialogues.jsonl'
    n = 0
    with out.open('w', encoding='utf-8') as fh:
        for d in done:
            msgs = P.messages([{'role': 'user', 'content': d['q']}, {'role': 'assistant', 'content': d['a']}],
                              d['src'], d['site'], d['lang'])
            fh.write(json.dumps({'type': d['type'], 'lang': d['lang'], 'messages': msgs}, ensure_ascii=False) + '\n'); n += 1
        for f, x in zip(follow, a2):
            if not good_answer(x, f['lang'], len(f['src2']), bool(f['site'])):
                continue
            msgs = P.messages([{'role': 'user', 'content': f['q']}, {'role': 'assistant', 'content': f['a']},
                               {'role': 'user', 'content': f['q2']}, {'role': 'assistant', 'content': x}],
                              f['src2'], f['site'], f['lang'])
            fh.write(json.dumps({'type': 'followup', 'lang': f['lang'], 'messages': msgs}, ensure_ascii=False) + '\n'); n += 1
    print('dialogues written', n, f'{time.time() - t0:.0f}s', flush=True)


if __name__ == '__main__':
    main()
