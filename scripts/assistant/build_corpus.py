"""Build the RAG corpus for the TwinGround assistant (2026-11-14; public-pages-only revision 2026-11-15).

Sources
  about short, hand-written passages on what TwinGround does, how to use it and which agency produced each dataset
        (written from the paper and the brief), so overview questions are not answered from the challenge title;
  own   public pages only: the full paper (EN/ZH, with its Supporting Information), the brief, the methods archive,
        the Search Candidates page and the research pages. Every passage links to the page (and, where the page has
        one, the section anchor) it came from. The README and the UI strings are not used: they have no public page
        and gave answers internal trivia (model hashes, lazy loading);
  refs  works cited by the paper: every reference is resolved through OpenAlex (by DOI, else by title); when OpenAlex
        lists a legal open-access PDF it is downloaded and its text is used, otherwise only the citation metadata
        (title, authors, year, venue, DOI) enters the corpus, linked to its DOI or to the paper's reference list.

Output (build/assistant/): chunks.jsonl, one passage per line
  {"id", "source": "about"|"own"|"ref", "doc", "title", "section", "url", "lang", "text"}
and refs.json (resolution record per reference: DOI, OA status, licence, PDF URL, sha256 of what was read).
Every passage has a human-readable title and a public URL; passages without one are dropped.

  python -m scripts.assistant.build_corpus               # own documents + references (OpenAlex, slow)
  python -m scripts.assistant.build_corpus --reuse-refs  # own documents + the reference passages already in chunks.jsonl
  python -m scripts.assistant.build_corpus --no-refs     # own documents only (offline)
After a rebuild, re-embed on the GPU host (vectors.npy must match chunks.jsonl line for line):
  cd scripts/assistant && python3 -c "from rag import Index; Index.build('<repo>/build/assistant/chunks.jsonl', '<e5 dir>')"
"""
import argparse
import hashlib
import html
import json
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'build/assistant'
PUB = ROOT / 'web/public'
TECH = PUB / 'technology'
UA = {'User-Agent': 'twinground-assistant-corpus/1.0'}
OPENALEX = 'https://api.openalex.org/works'

# (path, doc id, title, public url, lang). The full-text paper pages include the Supporting Information (S1-S11), so the
# SI PDFs and the shorter /technology/en.html would only duplicate them.
OWN_HTML = [
    (TECH / 'paper-en.html', 'paper_en', 'The Earth Ceiling (TwinGround paper)', '/technology/paper-en.html', 'en'),
    (TECH / 'paper.html', 'paper_zh', '地球上限（TwinGround 論文）', '/technology/paper.html', 'zh'),
    (TECH / 'brief-en.html', 'brief_en', 'How Close Can Earth Get? (TwinGround brief)', '/technology/brief-en.html', 'en'),
    (TECH / 'brief.html', 'brief_zh', '地球能多像月球與火星？（TwinGround 精簡版）', '/technology/brief.html', 'zh'),
    (TECH / 'archive-en.html', 'archive_en', 'Methods & evidence (TwinGround)', '/technology/archive-en.html', 'en'),
    (TECH / 'archive.html', 'archive_zh', '方法與原理（TwinGround）', '/technology/archive.html', 'zh'),
    (PUB / 'offcatalogue/en.html', 'offcat_en', 'Search Candidates (TwinGround)', '/offcatalogue/en.html', 'en'),
    (PUB / 'research/redesign-v1/index.html', 'research', 'Source-group image benchmark (TwinGround research)', '/research/redesign-v1/', 'en'),
    (PUB / 'research/redesign-v1/reliability/index.html', 'reliability', 'Classifier reliability audit (TwinGround research)', '/research/redesign-v1/reliability/', 'en'),
    (PUB / 'research/redesign-v1/source-rights/index.html', 'source_rights', 'Source rights & attribution (TwinGround)', '/research/redesign-v1/source-rights/', 'en'),
]
OWN_PDF = []  # the SI is part of the full-text paper pages above
REF_PAGES = [TECH / 'paper-en.html']
REF_LIST_URL = '/technology/paper-en.html#refs'
SKIP_SECTIONS = {'References', '參考文獻'}  # cited works enter as reference passages instead

# Hand-written overview passages (source 'about'). Facts restate the paper (Open Research, Data credits, S10) and the
# brief (sections 2 and 6); keep them in step with those pages.
ABOUT = [
    ('about_en', 'About TwinGround', 'What TwinGround does', '/', 'en',
     'TwinGround finds places on Earth whose measured terrain and conditions resemble a site you choose on the Moon or '
     'Mars. You pick a window on the lunar or Martian globe (20, 40 or 80 km across) and a use, such as resources, '
     'mobility, thermal work, base siting, astrobiology, subsurface or crew operations. TwinGround reads the properties '
     'of that window in Earth units and ranks Earth windows by how well their measured properties match it. For every '
     'candidate it shows which properties match, which do not and which Earth cannot supply at all, together with the '
     'Earth ceiling: the best score any measured Earth window reaches for that use. You can compare the query and a '
     'candidate side by side in 3D and walk both surfaces with an astronaut explorer. Candidates are screening results '
     'for a stated use, not verified analog sites, and scores are ranking scores, not probabilities. TwinGround was '
     'built for the NASA Space Apps Challenge 2026; it is not an official NASA product.'),
    ('about_en', 'About TwinGround', 'How to use the site', '/', 'en',
     'To use TwinGround, start on the Moon or on Mars from the home page, then choose a region or pick a spot on the '
     'globe, or describe the conditions you need in words. Run the search to open the results page: it lists the Earth '
     'candidates with their scores, the facets that match or break down, the Earth ceiling of the query and the '
     'conditions no Earth site reproduces (gravity, air pressure, the length of the day, radiation and the temperature '
     'range). Open a candidate to see its terrain next to the query in 3D, its imagery and its field-test notes, and '
     'walk the surface with the astronaut explorer. The Search Candidates page lists eight new Earth candidates found '
     'this way, and the paper explains the method and the tests behind it. This assistant answers questions about the '
     'site and the paper; on the results page it can also explain why the candidate you are viewing was chosen.'),
    ('about_en', 'About TwinGround', 'How the search ranks Earth sites', '/technology/brief-en.html', 'en',
     'How the search works: TwinGround reads the chosen lunar or Martian window in Earth units: FeO, TiO2, K and Th '
     'from the Lunar Prospector and Mars Odyssey gamma-ray spectrometers, albedo from LROC WAC and TES, and '
     'kilometre-scale roughness from LOLA and MOLA. It compares them with Earth windows that carry measured values '
     '(75,860 Earth windows of 40 km carry measurements: airborne K and Th in Australia and North America, topsoil FeO '
     'and TiO2 in the United States, Australia and Europe, snow-free albedo, roughness and surface temperature, plus '
     'estimates with 90% intervals within 300 km of measurements). For the chosen use, Earth windows are ranked by the '
     'probability that each property lies within a tolerance (for example FeO within 3 wt%, roughness within 1 degree, '
     'temperature within 20 K). The results page also scores ten facets for every candidate: terrain, surface material, '
     'thermal environment, sunlight, water and ice, dust and wind, surface processes, habitability, subsurface and '
     'operations. Each item is a match, a partial match, a break-down or unknown, and unknown items are never counted '
     'as zero.'),
    ('about_en', 'About TwinGround', 'Key terms: Earth ceiling, score, candidate', '/technology/brief-en.html', 'en',
     'Key terms. The Earth ceiling of a query is the best score any measured Earth window reaches for that query and '
     'use; every candidate is read against it, so it shows how close Earth can get at all. For lunar resource use the '
     'mean Earth ceiling is 0.75, and no Earth window matches FeO, TiO2, K and Th together. A score is a ranking score, '
     'not a probability that the site is a good analog. A candidate is an Earth window that ranks high for a stated '
     'use; it is a screening result, not a verified analog site. Conditions no Earth site reproduces, such as gravity, '
     'air pressure, the length of the day, surface radiation and the full temperature range, are listed but never '
     'scored.'),
    ('about_en', 'TwinGround data sources', 'Which agency produced each dataset', '/technology/paper-en.html#credits', 'en',
     'TwinGround uses public data from several agencies, not only NASA. NASA data: on the Moon, LOLA terrain, '
     'permanent-shadow and roughness (LRO), LROC WAC imagery (NASA/GSFC/Arizona State University), Diviner surface '
     'temperatures and water-ice stability (LRO), Mini-RF radar, and Lunar Prospector gamma-ray chemistry (FeO, TiO2, '
     'K, Th) and hydrogen; on Mars, MOLA terrain, the Mars Odyssey gamma-ray spectrometer, TES albedo and thermal '
     'data, HiRISE and CTX images; on Earth, NASA POWER climate normals (NASA Langley), MODIS land surface temperature '
     'and albedo, NASA Worldview images and Earthdata Search granule counts. Data from other agencies: JAXA (SELENE / '
     'Kaguya, the JAXA Earth database, AMSR2 soil moisture, GSMaP rain), ESA and Copernicus (Mars Express HRSC and '
     'OMEGA, the Copernicus DEM, Sentinel-1 and Sentinel-2, WorldCover, the CCI permafrost map), the Canadian Space '
     'Agency and Natural Resources Canada (RADARSAT-1 archive footprints and the RADARSAT Constellation land mosaic: '
     'Canadian data, not NASA data), USGS (Astrogeology maps, 3DEP elevation, US soil geochemistry), NOAA (ETOPO '
     '2022), Geoscience Australia and the North American radiometric grids (airborne K and Th), the FOREGS atlas of '
     'Europe, GEOROC rock analyses, GLiM, SoilGrids, GLASS albedo, the Mars Climate Database and the Smithsonian '
     'Global Volcanism Program. Full references and licences are in the paper.'),
    ('about_zh', '關於 TwinGround', 'TwinGround 做什麼', '/', 'zh',
     'TwinGround 在地球上找出實測地形與條件跟你選的月球或火星地點相似的地方。你在月球或火星的球面上選一個 20、40 或 80 公里的窗格，'
     '再選一個用途（資源、移動、熱環境、基地選址、天文生物、地下、乘員作業等）。TwinGround 把該窗格的性質換成地球單位，'
     '依實測性質的符合程度排序地球窗格；每個候選都會列出哪些性質符合、哪些不符合、哪些是地球根本做不到的，'
     '並給出「地球上限」：任何實測地球窗格對該用途能達到的最高分。你可以在 3D 中並排比較查詢地點與候選地點，'
     '並用太空人探索模式走在兩邊的地表上。候選地點是針對特定用途的篩選結果，不是已驗證的類比地；分數是排序分數，不是機率。'
     'TwinGround 是 NASA Space Apps Challenge 2026 的參賽作品，不是 NASA 官方產品。'),
    ('about_zh', 'TwinGround 資料來源', '各資料集出自哪個機構', '/technology/paper.html#credits', 'zh',
     'TwinGround 使用多個機構的公開資料，不只 NASA。NASA 資料：月球的 LOLA 地形與永久陰影、LROC WAC 影像、Diviner 表面溫度與水冰穩定度、'
     'Mini-RF 雷達、Lunar Prospector 伽瑪射線化學（FeO、TiO2、K、Th）與氫；火星的 MOLA 地形、Mars Odyssey 伽瑪射線光譜儀、TES、HiRISE 與 CTX；'
     '地球的 NASA POWER 氣候常年值、MODIS、NASA Worldview 影像與 Earthdata Search。其他機構：JAXA（SELENE／輝夜姬、JAXA Earth 資料庫、'
     'AMSR2 土壤水分、GSMaP 降雨）、ESA 與 Copernicus（HRSC、OMEGA、Copernicus DEM、Sentinel-1／2、WorldCover、CCI 永凍土）、'
     '加拿大太空總署與加拿大自然資源部（RADARSAT-1 檔案足跡與 RADARSAT Constellation 地表鑲嵌，屬加拿大資料，不是 NASA 資料）、'
     'USGS、NOAA（ETOPO 2022）、澳洲地球科學局與北美航空輻射網格、FOREGS、GEOROC、GLiM、SoilGrids、GLASS、火星氣候資料庫與史密森尼全球火山計畫。'),
]
MAX_CHARS = {'en': 1100, 'zh': 520}
OVERLAP = {'en': 180, 'zh': 80}


def clean(text):
    text = html.unescape(re.sub(r'<[^>]+>', ' ', text))
    return re.sub(r'\s+', ' ', text).strip()


def html_sections(raw, with_anchor=False):
    """Split a page at h1-h4; keep paragraph-like text; equations become [equation].

    with_anchor: also return the fragment id of each section: the heading's own id, else an id opened just before the
    heading (a <section id=...> wrapper), else the anchor of the enclosing higher-level section."""
    raw = re.sub(r'<(script|style|nav|svg)[\s\S]*?</\1>', ' ', raw, flags=re.I)
    raw = re.sub(r'<math[\s\S]*?</math>', ' [equation] ', raw, flags=re.I)
    parts = re.split(r'(<h[1-4][^>]*>[\s\S]*?</h[1-4]>)', raw, flags=re.I)
    section, anchor, levels, out, prev = '', '', {}, [], ''
    for part in parts:
        h = re.match(r'<h([1-4])([^>]*)>', part, flags=re.I)
        if h:
            section = clean(part)
            level = int(h.group(1))
            own = re.search(r'\bid="([^"]+)"', h.group(2))
            near = re.findall(r'\bid="([^"]+)"[^>]*>\s*$', prev[-300:])
            parent = next((levels[k] for k in range(level - 1, 0, -1) if levels.get(k)), '')
            anchor = own.group(1) if own else (near[-1] if near else parent)
            levels = {k: v for k, v in levels.items() if k < level}
            levels[level] = anchor
            continue
        prev = part
        blocks = re.findall(r'<(p|li|figcaption|td|th|blockquote|dd|dt)[^>]*>([\s\S]*?)</\1>', part, flags=re.I)
        text = '\n'.join(t for t in (clean(b) for _, b in blocks) if len(t) > 1)
        if not text:
            text = clean(part)
        if len(text) > 40:
            out.append((section, anchor, text) if with_anchor else (section, text))
    return out


def chunk(text, lang):
    n, ov = MAX_CHARS[lang], OVERLAP[lang]
    if len(text) <= n:
        return [text]
    sep = r'(?<=[。！？；])' if lang == 'zh' else r'(?<=[.!?;])\s+'
    sents, out, cur = re.split(sep, text), [], ''
    for s in sents:
        if cur and len(cur) + len(s) > n:
            out.append(cur.strip())
            cur = cur[-ov:] + ' ' + s
        else:
            cur = (cur + ' ' + s) if cur else s
    if cur.strip():
        out.append(cur.strip())
    return out


def lang_of(text):
    cjk = len(re.findall(r'[一-鿿]', text))
    return 'zh' if cjk > 0.15 * max(1, len(text)) else 'en'


def about_chunks():
    return [dict(source='about', doc=doc, title=title, section=section, url=url, lang=lang, text=text)
            for doc, title, section, url, lang, text in ABOUT]


def own_chunks():
    rows = []
    for path, doc, title, url, lang in OWN_HTML:
        if not path.exists():
            print('missing', path); continue
        for section, anchor, text in html_sections(path.read_text(encoding='utf-8'), with_anchor=True):
            if section in SKIP_SECTIONS:
                continue
            for c in chunk(text, lang):
                rows.append(dict(source='own', doc=doc, title=title, section=section,
                                 url=f'{url}#{anchor}' if anchor else url, lang=lang, text=c))
    for path, doc, title, url, lang in OWN_PDF:
        import pymupdf
        if not path.exists():
            print('missing', path); continue
        for pno, page in enumerate(pymupdf.open(path), 1):
            text = re.sub(r'\s+', ' ', page.get_text()).strip()
            for c in chunk(text, lang):
                if len(c) > 60:
                    rows.append(dict(source='own', doc=doc, title=title, section=f'page {pno}', url=f'{url}#page={pno}',
                                     lang=lang, text=c))
    return rows


def ref_title(ref):
    """'Author, A., & Author, B. (2020). Title of the work. Venue …' -> 'Author, A., & Author, B. (2020). Title of the work'"""
    m = re.match(r'^(.{2,250}?\((?:\d{4}[a-z]?|n\.d\.(?:-[a-z])?)\)\.\s*.+?[.?!])(?:\s|$)', ref)
    t = (m.group(1) if m else ref).rstrip('.')
    return t if len(t) <= 160 else t[:157].rstrip() + '…'


_REF_IDS = None


def ref_anchor(text):
    """Fragment id of a reference entry (<li id="ref-…">) of the English paper, matched on the entry's text."""
    global _REF_IDS
    if _REF_IDS is None:
        raw = REF_PAGES[0].read_text(encoding='utf-8')
        _REF_IDS = {clean(t)[:80]: i for i, t in re.findall(r'<li id="(ref-[^"]+)"[^>]*>([\s\S]*?)</li>', raw)}
    return _REF_IDS.get((text or '')[:80])


def tidy_ref(row):
    """Reference passages: a readable title and a public link (the DOI, else the entry in the paper's reference list)."""
    row = dict(row)
    if not row.get('url') or row['url'] == REF_LIST_URL:
        a = ref_anchor(row.get('text')) if row.get('doc') == 'citation' else None
        row['url'] = f"{REF_LIST_URL.split('#')[0]}#{a}" if a else REF_LIST_URL
    if row.get('doc') == 'citation' and row.get('title') == row.get('text'):
        row['title'] = ref_title(row['title'])
    return row


def reference_lines():
    """Reference entries of the paper pages (the <li>/<p> items after the References heading)."""
    refs = []
    for page in REF_PAGES:
        raw = page.read_text(encoding='utf-8')
        m = re.search(r'>\s*References\s*<', raw)
        if not m:
            continue
        tail = raw[m.end():]
        for item in re.findall(r'<(?:li|p)[^>]*>([\s\S]*?)</(?:li|p)>', tail):
            t = clean(item)
            if re.match(r'^[^()]{2,250}\((\d{4}[a-z]?|n\.d\.(-[a-z])?)\)\.', t) and len(t) < 900:
                refs.append(t)
    return list(dict.fromkeys(refs))


def get_json(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=40) as r:
        return json.loads(r.read())


def resolve(ref):
    doi = re.search(r'10\.\d{4,9}/[^\s"<>]+', ref)
    try:
        if doi:
            w = get_json(f'{OPENALEX}/doi:{urllib.parse.quote(doi.group(0).rstrip(".,);"))}')
        else:
            m = re.search(r'\(\d{4}[a-z]?\)\.\s*(.+?)[.?!]\s', ref)
            if not m:
                return None
            title = m.group(1)
            res = get_json(f'{OPENALEX}?search={urllib.parse.quote(title[:200])}&per-page=1')['results']
            w = res[0] if res else None
            if w and w.get('title'):
                a = set(re.findall(r'\w+', title.lower())); b = set(re.findall(r'\w+', w['title'].lower()))
                if len(a & b) / max(1, len(a | b)) < 0.5:
                    return None
        return w
    except Exception as exc:  # noqa: BLE001
        print('openalex failed:', ref[:60], exc)
        return None


def pdf_text(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read(60_000_000)
    if not data.startswith(b'%PDF'):
        return None, None
    import pymupdf
    doc = pymupdf.open(stream=data, filetype='pdf')
    text = '\n'.join(p.get_text() for p in doc)
    return re.sub(r'[ \t]+', ' ', text), hashlib.sha256(data).hexdigest()


def ref_chunks():
    rows, record = [], []
    for ref in reference_lines():
        w = resolve(ref)
        time.sleep(0.15)
        rec = {'reference': ref, 'openalex': (w or {}).get('id'), 'doi': (w or {}).get('doi'),
               'is_oa': bool((w or {}).get('open_access', {}).get('is_oa')), 'pdf_url': None, 'license': None,
               'sha256': None, 'used': 'citation'}
        title = (w or {}).get('title') or ref
        url = (w or {}).get('doi') or ''
        rows.append(dict(source='ref', doc='citation', title=title, section='citation', url=url, lang='en', text=ref))
        locs = [(w or {}).get('best_oa_location') or {}] + list((w or {}).get('oa_locations') or [])
        urls = list(dict.fromkeys(l.get('pdf_url') for l in locs if l and l.get('pdf_url')))
        if rec['is_oa'] and urls:
            for pdf in urls:  # every legal OA copy OpenAlex lists (publisher, repository, arXiv, PMC)
                try:
                    text, sha = pdf_text(pdf)
                except Exception as exc:  # noqa: BLE001
                    text, sha = None, None
                    print('pdf failed:', pdf[:80], exc)
                if text and len(text) > 2000:
                    lic = next((l.get('license') for l in locs if l and l.get('pdf_url') == pdf), None)
                    rec.update(pdf_url=pdf, license=lic, sha256=sha, used='full_text')
                    text = re.split(r'\n\s*(References|REFERENCES|Bibliography|Literature Cited)\s*\n', text)[0]
                    for c in chunk(re.sub(r'\s+', ' ', text), lang_of(text[:5000])):
                        rows.append(dict(source='ref', doc=(w.get('id') or '').rsplit('/', 1)[-1], title=title,
                                         section='full text', url=url, lang='en', text=c))
                    break
        record.append(rec)
        print(f"{rec['used']:10s} {title[:70]}")
    return rows, record


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--no-refs', action='store_true')
    ap.add_argument('--reuse-refs', action='store_true',
                    help='take the reference passages from the existing chunks.jsonl instead of OpenAlex')
    a = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    rows = about_chunks() + own_chunks()
    record = []
    if a.reuse_refs:
        old = [json.loads(l) for l in (OUT / 'chunks.jsonl').open(encoding='utf-8')]
        rows += [{k: v for k, v in r.items() if k != 'id'} for r in old if r.get('source') == 'ref']
    elif not a.no_refs:
        r, record = ref_chunks()
        rows += r
        (OUT / 'refs.json').write_text(json.dumps(record, ensure_ascii=False, indent=1), encoding='utf-8')
    rows = [tidy_ref(r) if r['source'] == 'ref' else r for r in rows]
    dropped = [r for r in rows if not r.get('url') or not r.get('title')]
    if dropped:
        print('dropped', len(dropped), 'passages without a public page')
    rows = [r for r in rows if r.get('url') and r.get('title')]
    seen, final = set(), []
    for row in rows:
        h = hashlib.sha1(row['text'].encode('utf-8')).hexdigest()
        if h in seen:
            continue
        seen.add(h)
        row['id'] = f"{row['doc']}:{len(final)}"
        final.append(row)
    with open(OUT / 'chunks.jsonl', 'w', encoding='utf-8') as f:
        for row in final:
            f.write(json.dumps(row, ensure_ascii=False) + '\n')
    by = {}
    for row in final:
        key = row['doc'] if row['source'] != 'ref' else 'ref:' + ('citation' if row['doc'] == 'citation' else 'full')
        by[key] = by.get(key, 0) + 1
    print(len(final), 'chunks', json.dumps(by, ensure_ascii=False))
    if record:
        print(sum(r['used'] == 'full_text' for r in record), 'of', len(record), 'references read in full (open access)')


if __name__ == '__main__':
    main()
