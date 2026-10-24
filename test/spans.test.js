// Tests for src/spans.js, using an in-memory span exporter.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace';
import { SpanStatusCode } from '@opentelemetry/api';

import { inSpan } from '../src/spans.js';

const exporter = new InMemorySpanExporter();
const processor = new SimpleSpanProcessor({ exporter });
const sdk = new NodeSDK({
  spanProcessors: [processor],
  instrumentations: [],
  metricReaders: [],
  logRecordProcessors: [],
});
sdk.start();
after(() => sdk.shutdown());

// Finished spans are handed to the exporter asynchronously: flush first.
async function finishedSpan(name) {
  await processor.forceFlush();
  return exporter.getFinishedSpans().find((span) => span.name === name);
}

test('inSpan: returns what the work returns, and nests spans started inside it', async () => {
  exporter.reset();
  const value = await inSpan('outer', { 'game.id': '7' }, async () => {
    await inSpan('inner', {}, async () => {});
    return 42;
  });

  assert.equal(value, 42);
  const outer = await finishedSpan('outer');
  const inner = await finishedSpan('inner');
  assert.equal(outer.attributes['game.id'], '7');
  assert.equal(inner.spanContext().traceId, outer.spanContext().traceId);
  assert.equal(inner.parentSpanContext.spanId, outer.spanContext().spanId);
});

test('inSpan: an error is recorded on the span and thrown on', async () => {
  exporter.reset();
  await assert.rejects(
    inSpan('failing', {}, async () => {
      throw new Error('database is down');
    }),
    /database is down/,
  );

  const span = await finishedSpan('failing');
  assert.equal(span.status.code, SpanStatusCode.ERROR);
  assert.equal(span.status.message, 'database is down');
  assert.equal(span.events[0].name, 'exception');
});
