"""Build the RAG corpus for the TwinGround assistant (2026-11-14).

Sources
  own   our paper (EN/ZH web versions and SI PDFs), the brief, the archive pages, the research pages, the README and the
        UI text (i18n), so the assistant can explain both the science and how to use the site;
  refs  works cited by the paper: every reference is resolved through OpenAlex (by DOI, else by title); when OpenAlex
        lists a legal open-access PDF it is downloaded and its text is used, otherwise only the citation metadata
        (title, authors, year, venue, DOI) enters the corpus, so the assistant can still cite it.

Output (build/assistant/): chunks.jsonl, one passage per line
  {"id", "source": "own"|"ref", "doc", "title", "section", "url", "lang", "text"}
and refs.json (resolution record per reference: DOI, OA status, licence, PDF URL, sha256 of what was read).

  python -m scripts.assistant.build_corpus            # own documents + references
  python -m scripts.assistant.build_corpus --no-refs  # own documents only (offline)
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

# (path, doc id, title, public url, lang)
OWN_HTML = [
    (TECH / 'en.html', 'paper_en', 'The Earth Ceiling (TwinGround paper)', '/technology/en.html', 'en'),
    (TECH / 'index.html', 'paper_zh', 'The Earth Ceiling（TwinGround 論文，中文）', '/technology/', 'zh'),
    (TECH / 'brief-en.html', 'brief_en', 'How Close Can Earth Get? (TwinGround brief)', '/technology/brief-en.html', 'en'),
    (TECH / 'brief.html', 'brief_zh', 'TwinGround 簡報', '/technology/brief.html', 'zh'),
    (TECH / 'archive-en.html', 'archive_en', 'TwinGround technical archive', '/technology/archive-en.html', 'en'),
    (TECH / 'archive.html', 'archive_zh', 'TwinGround 技術檔案', '/technology/archive.html', 'zh'),
    (PUB / 'research/redesign-v1/index.html', 'research', 'TwinGround research report', '/research/redesign-v1/', 'en'),
    (PUB / 'research/redesign-v1/reliability/index.html', 'reliability', 'Reliability report', '/research/redesign-v1/reliability/', 'en'),
    (PUB / 'research/redesign-v1/source-rights/index.html', 'source_rights', 'Data sources and rights', '/research/redesign-v1/source-rights/', 'en'),
]
OWN_PDF = [
    (TECH / 'static/pdfs/analog_atlas_paper_en_si.pdf', 'si_en', 'Supporting Information (EN)', '/technology/static/pdfs/analog_atlas_paper_en_si.pdf', 'en'),
    (TECH / 'static/pdfs/analog_atlas_paper_zh_si.pdf', 'si_zh', 'Supporting Information（中文）', '/technology/static/pdfs/analog_atlas_paper_zh_si.pdf', 'zh'),
]
REF_PAGES = [TECH / 'en.html', TECH / 'paper-en.html']
MAX_CHARS = {'en': 1100, 'zh': 520}
OVERLAP = {'en': 180, 'zh': 80}


def clean(text):
    text = html.unescape(re.sub(r'<[^>]+>', ' ', text))
    return re.sub(r'\s+', ' ', text).strip()


def html_sections(raw):
    """Split a page at h1-h4; keep paragraph-like text; equations become [equation]."""
    raw = re.sub(r'<(script|style|nav|svg)[\s\S]*?</\1>', ' ', raw, flags=re.I)
    raw = re.sub(r'<math[\s\S]*?</math>', ' [equation] ', raw, flags=re.I)
    parts = re.split(r'(<h[1-4][^>]*>[\s\S]*?</h[1-4]>)', raw, flags=re.I)
    section, out = '', []
    for part in parts:
        if re.match(r'<h[1-4]', part, flags=re.I):
            section = clean(part)
            continue
        blocks = re.findall(r'<(p|li|figcaption|td|th|blockquote|dd|dt)[^>]*>([\s\S]*?)</\1>', part, flags=re.I)
        text = '\n'.join(t for t in (clean(b) for _, b in blocks) if len(t) > 1)
        if not text:
            text = clean(part)
        if len(text) > 40:
            out.append((section, text))
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


def own_chunks():
    rows = []
    for path, doc, title, url, lang in OWN_HTML:
        if not path.exists():
            print('missing', path); continue
        for section, text in html_sections(path.read_text(encoding='utf-8')):
            for i, c in enumerate(chunk(text, lang)):
                rows.append(dict(source='own', doc=doc, title=title, section=section, url=url, lang=lang, text=c))
    import pymupdf
    for path, doc, title, url, lang in OWN_PDF:
        if not path.exists():
            print('missing', path); continue
        for pno, page in enumerate(pymupdf.open(path), 1):
            text = re.sub(r'\s+', ' ', page.get_text()).strip()
            for c in chunk(text, lang):
                if len(c) > 60:
                    rows.append(dict(source='own', doc=doc, title=title, section=f'page {pno}', url=f'{url}#page={pno}',
                                     lang=lang, text=c))
    readme = (ROOT / 'README.md').read_text(encoding='utf-8')
    for block in re.split(r'\n(?=#+ )', readme):
        head = block.split('\n', 1)[0].lstrip('# ').strip()
        for c in chunk(re.sub(r'\s+', ' ', block), 'en'):
            rows.append(dict(source='own', doc='readme', title='TwinGround README', section=head, url='', lang='en', text=c))
    for path in sorted((ROOT / 'web/i18n').glob('*.json')):
        strings = []

        def walk(v):
            if isinstance(v, dict):
                for x in v.values():
                    walk(x)
            elif isinstance(v, list):
                for x in v:
                    walk(x)
            elif isinstance(v, str) and len(v) > 25 and '{' not in v[:2]:
                strings.append(clean(v))
        walk(json.loads(path.read_text(encoding='utf-8')))
        for c in chunk('\n'.join(dict.fromkeys(strings)), 'en'):
            rows.append(dict(source='own', doc='ui_' + path.stem.split('.')[0], title='TwinGround interface text',
                             section=path.stem, url='', lang='en', text=c))
    return rows


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
    a = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    rows = own_chunks()
    record = []
    if not a.no_refs:
        r, record = ref_chunks()
        rows += r
        (OUT / 'refs.json').write_text(json.dumps(record, ensure_ascii=False, indent=1), encoding='utf-8')
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
        by[row['doc'] if row['source'] == 'own' else row['source'] + ':' + ('citation' if row['doc'] == 'citation' else 'full')] = by.get(row['doc'] if row['source'] == 'own' else row['source'] + ':' + ('citation' if row['doc'] == 'citation' else 'full'), 0) + 1
    print(len(final), 'chunks', json.dumps(by, ensure_ascii=False))
    if record:
        print(sum(r['used'] == 'full_text' for r in record), 'of', len(record), 'references read in full (open access)')


if __name__ == '__main__':
    main()
