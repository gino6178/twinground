"""Full fine-tune of Llama 3.2 1B Instruct as the TwinGround assistant (2026-11-14).

  torchrun --nproc_per_node 8 train.py --base ~/models/llama1b --data ~/work/dialogues.jsonl --out ~/work/assistant-1b

Loss is computed on assistant turns only (system context, retrieved sources and user turns are masked). 3 % of the
dialogues are held out; eval loss is reported each half epoch and the final model is saved in bf16 with its tokenizer.
"""
import argparse
import json
import random

import torch
from torch.utils.data import Dataset
from transformers import (AutoModelForCausalLM, AutoTokenizer, Trainer, TrainingArguments,
                          DataCollatorForSeq2Seq)


class Dialogues(Dataset):
    def __init__(self, rows, tok, max_len):
        self.items = []
        for r in rows:
            ids, labels = [], []
            msgs = r['messages']
            for i in range(len(msgs)):
                prefix = tok.apply_chat_template(msgs[:i], tokenize=False) if i else ''
                full = tok.apply_chat_template(msgs[:i + 1], tokenize=False)
                piece = full[len(prefix):]
                p_ids = tok(piece, add_special_tokens=False)['input_ids']
                ids += p_ids
                labels += p_ids if msgs[i]['role'] == 'assistant' else [-100] * len(p_ids)
            if len(ids) > max_len:  # keep the end: the last answer must survive
                ids, labels = ids[-max_len:], labels[-max_len:]
            if any(x != -100 for x in labels):
                self.items.append({'input_ids': ids, 'labels': labels, 'attention_mask': [1] * len(ids)})

    def __len__(self):
        return len(self.items)

    def __getitem__(self, i):
        return self.items[i]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--base', required=True)
    ap.add_argument('--data', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--epochs', type=float, default=3)
    ap.add_argument('--lr', type=float, default=2e-5)
    ap.add_argument('--max-len', type=int, default=6144)
    a = ap.parse_args()
    tok = AutoTokenizer.from_pretrained(a.base)
    tok.pad_token = tok.pad_token or '<|finetune_right_pad_id|>'
    rows = [json.loads(l) for l in open(a.data, encoding='utf-8')]
    random.Random(0).shuffle(rows)
    n_eval = max(100, int(0.03 * len(rows)))
    train, evals = Dialogues(rows[n_eval:], tok, a.max_len), Dialogues(rows[:n_eval], tok, a.max_len)
    with open(a.data + '.heldout.jsonl', 'w', encoding='utf-8') as f:  # never trained on; probe.py scores these
        for r in rows[:n_eval]:
            f.write(json.dumps(r, ensure_ascii=False) + '\n')
    model = AutoModelForCausalLM.from_pretrained(a.base, torch_dtype=torch.bfloat16, attn_implementation='sdpa')
    world = max(1, torch.cuda.device_count())
    args = TrainingArguments(
        output_dir=a.out + '-ckpt', num_train_epochs=a.epochs, learning_rate=a.lr, lr_scheduler_type='cosine',
        warmup_ratio=0.03, weight_decay=0.0, per_device_train_batch_size=1, per_device_eval_batch_size=1,
        gradient_accumulation_steps=max(1, 32 // world), bf16=True, logging_steps=10, eval_strategy='steps',
        eval_steps=max(20, len(train) // 64), save_strategy='no', report_to=[], gradient_checkpointing=True,
        dataloader_num_workers=2, group_by_length=True, ddp_find_unused_parameters=False)
    trainer = Trainer(model=model, args=args, train_dataset=train, eval_dataset=evals,
                      data_collator=DataCollatorForSeq2Seq(tok, padding=True, pad_to_multiple_of=8))
    trainer.train()
    print('final eval', trainer.evaluate(), flush=True)
    if trainer.is_world_process_zero():
        trainer.save_model(a.out)
        tok.save_pretrained(a.out)


if __name__ == '__main__':
    main()
