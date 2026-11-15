# Site assistant

How the **Ask** assistant is built, trained and deployed. Back to the [README](../README.md). The method and its evaluation are described in the [Methods paper](https://twinground.theminimallab.com/technology/paper-en.html).

## How it answers

A chat button on every page (`web/src/assistant_widget.jsx`) answers questions about the site and the method and, on the results page, explains why the viewed candidate was chosen.

1. The page sends the conversation (and, on the results page, the search result it already holds) to `POST /api/assistant`.
2. The web server turns the search result into a plain-text site brief (`scripts/assistant/site_brief.py`) and forwards it with the conversation to the assistant service (`scripts/assistant/service.py`, `127.0.0.1:8791`).
3. The service retrieves passages with Microsoft multilingual-e5-base (`rag.py`, dense search plus a small lexical boost) and answers with the fine-tuned Llama 3.2 1B, using the prompt format in `prompt.py`.
4. Every answer lists the passages it was given; citations outside them are removed.

The model explains results. It never ranks sites or changes numbers: those come from the search pipeline.

## Model rule: US-origin models only

Use only US-origin models anywhere in the assistant (teacher, fine-tune base, embedding and reranker models): for example Meta Llama, Microsoft e5 or Google Gemma, not Qwen, DeepSeek, BAAI/BGE, Yi or GLM. **Why:** this is a NASA competition entry, and that context is sensitive to models from mainland China, so the team keeps its whole AI stack to US-origin open-weight models. Check a model's origin before adding it.

Current models: Meta Llama 3.3 70B Instruct (teacher), Meta Llama 3.2 1B Instruct (student), Microsoft multilingual-e5-base (retriever).

## Building it (`scripts/assistant/`)

1. **Corpus.** `build_corpus.py` builds the retrieval corpus from short "About TwinGround" and data-source passages, the public pages only (the Methods paper with its Supporting Information, the brief, the methods archive, Search Candidates and the research pages; every passage links to its page and section) and the works the paper cites (open-access full text through OpenAlex, otherwise the citation only). Output: `build/assistant/chunks.jsonl`.
2. **Real search cases.** `dump_site_cases.py`, run next to the live server, saves site briefs of real search results:
   `python -m scripts.assistant.dump_site_cases --n 700 --out ~/assistant/site_cases.jsonl`
3. **Training dialogues.** `gen_dialogues.py`, on a GPU node, has Meta Llama 3.3 70B Instruct (vLLM) write questions and grounded answers in the exact prompt format of `prompt.py` (paper questions, site explanations, out-of-scope requests, follow-ups):
   `python gen_dialogues.py --teacher <llama-70b dir> --e5 <e5 dir> --work <work dir>`
4. **Fine-tune.** `train.py` runs a full fine-tune of Llama 3.2 1B Instruct on those dialogues (loss on assistant turns only):
   `torchrun --nproc_per_node 8 train.py --base <llama-1b dir> --data <work>/dialogues.jsonl --out <work>/assistant-1b`
5. **Check.** `probe.py` runs fixed questions and scores held-out dialogues before deployment:
   `python probe.py <model dir> <rag dir> <e5 dir> <site_cases.jsonl> [held-out dialogues.jsonl]`

## Rebuilding the corpus after a page changes

When a public page (for example the Methods paper) changes, rebuild the corpus and keep the reference passages already fetched:

```bash
python -m scripts.assistant.build_corpus --reuse-refs
```

(`--no-refs` builds the site's own passages only; with no flag the references are fetched again from OpenAlex, which is slow.)

Then copy `build/assistant/chunks.jsonl` to the VM, re-embed it there (`vectors.npy` must match `chunks.jsonl` line for line), and restart the service:

```bash
cd ~/nasa_2026/comp1/scripts/assistant
python3 -c "from rag import Index; Index.build('$HOME/nasa_2026/comp1/build/assistant/chunks.jsonl', '$HOME/llm/e5')"
systemctl --user restart twinground-assistant
```

## Deploying

On the VM the service expects the fine-tuned model in `~/llm/assistant`, the e5 model in `~/llm/e5`, and `build/assistant/` (chunks + vectors) in the checkout. Then:

```bash
systemctl --user enable --now twinground-assistant
```

The web server reaches it through `ANALOG_ASSISTANT_URL` (default `http://127.0.0.1:8791/ask`). See [deployment](deployment.md) for the other services.
