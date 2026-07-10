import type { WorkloadId } from "../shared/types.js";

export interface Workload {
  id: WorkloadId;
  name: string;
  corpus: string;
  prompt: string;
}

const proseCorpus = `At the edge of the city, the test track woke before sunrise. Floodlights faded as a thin orange line appeared behind the grandstand, and three silent machines rolled toward the start. Their bodywork carried no sponsor marks, only bright numbers painted across the doors. Engineers watched from the pit wall with stopwatches, notebooks, and cups of coffee cooling beside their keyboards.

The first signal measured responsiveness. A lamp flashed once, and each machine answered with a sharp pulse of light. The second signal measured sustained pace. The cars accelerated together, leaving clean ribbons of sound along the straight. One leapt forward immediately, another gathered speed with remarkable smoothness, and the third held a steady line that seemed almost effortless.

No single number told the whole story. A quick start could create an early lead, while consistent speed could erase it before the finish. The team therefore recorded the first movement, every interval, and the exact moment each car crossed the line. When the track finally fell quiet, the result was simple enough to read at a glance and detailed enough to study later.`;

const codeCorpus = `type Sample = {
  at: number;
  tokens: number;
};

export function summarize(samples: Sample[]) {
  if (samples.length < 2) {
    return { durationMs: 0, tokens: 0, tps: 0 };
  }

  const ordered = [...samples].sort((a, b) => a.at - b.at);
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  const durationMs = Math.max(1, last.at - first.at);
  const tokens = ordered.reduce((total, sample) => total + sample.tokens, 0);

  return {
    durationMs,
    tokens,
    tps: Number((tokens / (durationMs / 1000)).toFixed(2)),
  };
}

export async function race<T>(jobs: Array<() => Promise<T>>) {
  const startedAt = performance.now();
  const results = await Promise.all(
    jobs.map(async (job, lane) => {
      const readyAt = performance.now();
      const value = await job();
      const finishedAt = performance.now();
      return {
        lane,
        value,
        setupMs: readyAt - startedAt,
        elapsedMs: finishedAt - startedAt,
      };
    }),
  );

  return results.sort((a, b) => a.elapsedMs - b.elapsedMs);
}`;

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
  { id: "prose", name: "Prose heat", corpus: proseCorpus, prompt: makePrompt(proseCorpus) },
  { id: "code", name: "Code heat", corpus: codeCorpus, prompt: makePrompt(codeCorpus) },
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
