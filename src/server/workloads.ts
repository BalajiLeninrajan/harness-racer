import type { WorkloadId } from "../shared/types.js";

export interface Workload {
  id: WorkloadId;
  name: string;
  corpus: string;
  prompt: string;
}

// Abstract from “Attention Is All You Need” by Vaswani et al.
// Source: https://arxiv.org/abs/1706.03762
const proseCorpus = `The dominant sequence transduction models are based on complex recurrent or convolutional neural networks in an encoder-decoder configuration. The best performing models also connect the encoder and decoder through an attention mechanism. We propose a new simple network architecture, the Transformer, based solely on attention mechanisms, dispensing with recurrence and convolutions entirely.

Experiments on two machine translation tasks show these models to be superior in quality while being more parallelizable and requiring significantly less time to train. Our model achieves 28.4 BLEU on the WMT 2014 English-to-German translation task, improving over the existing best results, including ensembles by over 2 BLEU.

On the WMT 2014 English-to-French translation task, our model establishes a new single-model state-of-the-art BLEU score of 41.8 after training for 3.5 days on eight GPUs, a small fraction of the training costs of the best models from the literature. We show that the Transformer generalizes well to other tasks by applying it successfully to English constituency parsing both with large and limited training data.`;

// nanoGPT's causal self-attention forward pass. The source is MIT-licensed.
// Source: https://github.com/karpathy/nanoGPT/blob/master/model.py
const codeCorpus = `def forward(self, x):
    B, T, C = x.size() # batch size, sequence length, embedding dimensionality (n_embd)

    # calculate query, key, values for all heads in batch and move head forward to be the batch dim
    q, k, v = self.c_attn(x).split(self.n_embd, dim=2)
    k = k.view(B, T, self.n_head, C // self.n_head).transpose(1, 2) # (B, nh, T, hs)
    q = q.view(B, T, self.n_head, C // self.n_head).transpose(1, 2) # (B, nh, T, hs)
    v = v.view(B, T, self.n_head, C // self.n_head).transpose(1, 2) # (B, nh, T, hs)

    # causal self-attention; Self-attend: (B, nh, T, hs) x (B, nh, hs, T) -> (B, nh, T, T)
    if self.flash:
        # efficient attention using Flash Attention CUDA kernels
        y = torch.nn.functional.scaled_dot_product_attention(q, k, v, attn_mask=None, dropout_p=self.dropout if self.training else 0, is_causal=True)
    else:
        # manual implementation of attention
        att = (q @ k.transpose(-2, -1)) * (1.0 / math.sqrt(k.size(-1)))
        att = att.masked_fill(self.bias[:,:,:T,:T] == 0, float('-inf'))
        att = F.softmax(att, dim=-1)
        att = self.attn_dropout(att)
        y = att @ v # (B, nh, T, T) x (B, nh, T, hs) -> (B, nh, T, hs)

    y = y.transpose(1, 2).contiguous().view(B, T, C) # re-assemble all head outputs side by side

    # output projection
    y = self.resid_dropout(self.c_proj(y))
    return y`;

function makePrompt(corpus: string): string {
  return [
    "This is a streaming-speed benchmark. Do not use tools, inspect files, or explain your answer.",
    "Return the exact text between <payload> and </payload>, character for character.",
    "Do not include the tags, Markdown fences, a preface, or a trailing explanation.",
    "<payload>",
    corpus,
    "</payload>",
  ].join("\n");
}

export const workloads: Workload[] = [
  { id: "prose", name: "Attention Is All You Need", corpus: proseCorpus, prompt: makePrompt(proseCorpus) },
  { id: "code", name: "nanoGPT causal self-attention", corpus: codeCorpus, prompt: makePrompt(codeCorpus) },
];

export function validateOutput(output: string, expected: string): { valid: boolean; message?: string } {
  const normalized = output.replace(/\r\n/g, "\n").replace(/\n$/, "");
  const target = expected.replace(/\r\n/g, "\n").replace(/\n$/, "");
  if (normalized === target) return { valid: true };

  const ratio = normalized.length / Math.max(1, target.length);
  return {
    valid: false,
    message: `Output did not match the fixed corpus (${Math.round(ratio * 100)}% of target length).`,
  };
}
