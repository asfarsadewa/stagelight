/// <reference lib="webworker" />
import { analyze } from './analyze';
import type { AnalyzerRequest, AnalyzerResponse } from './types';

/** Message-passing shell. All the analysis lives in `analyze.ts`. */

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (e: MessageEvent<AnalyzerRequest>) => {
  const post = (msg: AnalyzerResponse) => ctx.postMessage(msg);
  try {
    const result = analyze(e.data.samples, e.data.sampleRate, (value, stage) =>
      post({ type: 'progress', value, stage }),
    );
    post({ type: 'done', result });
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
