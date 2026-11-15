"""Retriever for the TwinGround assistant (2026-11-14): multilingual-e5 (Microsoft) dense search plus a small lexical boost.

  index = Index.build('build/assistant/chunks.jsonl', model_dir)   # embeds every passage, saves .npy next to the corpus
  index = Index.load('build/assistant', model_dir)
  index.search('為什麼月海玄武岩在地球上找不到？', k=4)
"""
import json
import re
from pathlib import Path

import numpy as np


def _tokens(text):
    return set(re.findall(r'[a-z0-9]+(?:\.[0-9]+)?|[一-鿿]', text.lower()))


class Index:
    def __init__(self, chunks, vectors, model):
        self.chunks, self.vectors, self.model = chunks, vectors, model
        self.toks = [_tokens(c['title'] + ' ' + c['text']) for c in chunks]

    @staticmethod
    def _model(model_dir, device=None):
        from sentence_transformers import SentenceTransformer
        return SentenceTransformer(str(model_dir), device=device)

    @classmethod
    def build(cls, corpus, model_dir, device=None, batch=64):
        corpus = Path(corpus)
        chunks = [json.loads(l) for l in corpus.open(encoding='utf-8')]
        model = cls._model(model_dir, device)
        texts = ['passage: ' + (c['title'] + '. ' + c['text'])[:1800] for c in chunks]
        vec = model.encode(texts, batch_size=batch, normalize_embeddings=True, show_progress_bar=True).astype(np.float32)
        np.save(corpus.with_name('vectors.npy'), vec)
        return cls(chunks, vec, model)

    @classmethod
    def load(cls, folder, model_dir, device=None):
        folder = Path(folder)
        chunks = [json.loads(l) for l in (folder / 'chunks.jsonl').open(encoding='utf-8')]
        return cls(chunks, np.load(folder / 'vectors.npy'), cls._model(model_dir, device))

    def embed_queries(self, queries, batch=64):
        return self.model.encode(['query: ' + q for q in queries], batch_size=batch, normalize_embeddings=True,
                                 show_progress_bar=len(queries) > 200).astype(np.float32)

    def search_vec(self, qvec, qtext, k=4, max_chars=2600, prefer_lang=None):
        sim = self.vectors @ qvec
        qt = _tokens(qtext)
        cand = np.argsort(-sim)[:40]
        scored = []
        for i in cand:
            lex = len(qt & self.toks[i]) / (len(qt) + 3) if qt else 0.0
            s = float(sim[i]) + 0.08 * lex
            c = self.chunks[i]
            if c['doc'] == 'citation':
                s -= 0.03  # bare citations only when nothing better
            if c.get('source') == 'about':
                s += 0.02  # the short overview passages state definitions plainly; prefer them when they are close
            if prefer_lang and c['lang'] == prefer_lang:
                s += 0.01
            scored.append((s, int(i)))
        scored.sort(reverse=True)
        out, used, seen_text = [], 0, set()
        for s, i in scored:
            c = self.chunks[i]
            key = c['text'][:120]
            if key in seen_text:
                continue
            if used + len(c['text']) > max_chars and out:
                continue
            seen_text.add(key)
            out.append({**c, 'score': round(s, 4)})
            used += len(c['text'])
            if len(out) >= k:
                break
        return out

    def search(self, query, k=4, max_chars=2600, prefer_lang=None):
        return self.search_vec(self.embed_queries([query])[0], query, k, max_chars, prefer_lang)
