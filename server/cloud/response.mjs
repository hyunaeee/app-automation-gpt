import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Send large generated assets through Vercel's streaming response path. */
export function streamBody(res, body) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
  function* chunks() {
    for (let offset = 0; offset < buffer.length; offset += 64 * 1024) yield buffer.subarray(offset, offset + 64 * 1024);
  }
  res.flushHeaders?.();
  return pipeline(Readable.from(chunks(), { objectMode: false }), res).catch(error => {
    // A disconnected browser must not become an unhandled API rejection. The
    // pipeline already stopped reading and released its transport listeners.
    if (!res.destroyed) res.destroy(error);
  });
}

/** List cards do not need image bytes, source, or historical execution logs. */
export function projectListSummary(project) {
  const { files, logs, plan, checks, reviewHistory, modelUsage, ...metadata } = project;
  return { ...metadata, summaryOnly: true, files: [], logs: [], plan: null, checks: [] };
}
