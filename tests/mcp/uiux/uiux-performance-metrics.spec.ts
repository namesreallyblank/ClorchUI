/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 */

import { test, expect, parseResponse } from '../fixtures';

test.describe.configure({ retries: 2 });

function extractJsonBlock(text: string): any {
  // The tool wraps raw metrics in a ```json fenced block at the end
  const m = text.match(/```json\n([\s\S]*?)\n```/);
  expect(m).not.toBeNull();
  return JSON.parse(m![1]);
}

async function callPerf(client: any, args: Record<string, any> = {}) {
  const raw = await client.callTool({ name: 'uiux_performance_metrics', arguments: args });
  const parsed = parseResponse(raw);
  expect(parsed?.result).toBeDefined();
  return extractJsonBlock(parsed!.result!);
}

test('Core Web Vitals fields are present with value+rating shape', async ({ client, server }) => {
  server.setContent('/', `
    <!doctype html>
    <html><head><title>Perf</title></head>
    <body><h1>Hello</h1><p>Content</p></body></html>
  `, 'text/html');

  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  const metrics = await callPerf(client, { waitForLoad: true });

  for (const name of ['lcp', 'cls', 'fcp', 'ttfb', 'inp']) {
    expect(metrics).toHaveProperty(name);
    expect(metrics[name]).toHaveProperty('value');
    expect(metrics[name]).toHaveProperty('rating');
    // value is number | null
    if (metrics[name].value !== null)
      expect(typeof metrics[name].value).toBe('number');
    // rating is string | null
    if (metrics[name].rating !== null)
      expect(['good', 'needs-improvement', 'poor']).toContain(metrics[name].rating);
  }
});

test('Navigation Timing fields are present', async ({ client, server }) => {
  server.setContent('/', `<!doctype html><html><body>ok</body></html>`, 'text/html');

  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  const metrics = await callPerf(client, { waitForLoad: true });

  expect(metrics).toHaveProperty('domContentLoaded');
  expect(metrics).toHaveProperty('domInteractive');
  // Both should be numbers (non-null) after load
  expect(typeof metrics.domContentLoaded).toBe('number');
  expect(typeof metrics.domInteractive).toBe('number');
});

test('longTasks and longTasksTotal are emitted', async ({ client, server }) => {
  server.setContent('/', `<!doctype html><html><body>ok</body></html>`, 'text/html');

  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  const metrics = await callPerf(client, { waitForLoad: true });

  expect(Array.isArray(metrics.longTasks)).toBe(true);
  expect(metrics.longTasksTotal).toBeDefined();
  expect(typeof metrics.longTasksTotal.count).toBe('number');
  expect(typeof metrics.longTasksTotal.totalDurationMs).toBe('number');
});

test('resources count and totalSize emitted', async ({ client, server }) => {
  server.setContent('/', `<!doctype html><html><body>ok</body></html>`, 'text/html');

  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  const metrics = await callPerf(client, { waitForLoad: true });

  expect(metrics.resources).toBeDefined();
  expect(typeof metrics.resources.count).toBe('number');
  expect(typeof metrics.resources.totalSize).toBe('number');
});

test.skip('INP threshold ratings (≤200 good, ≤500 needs-improvement, >500 poor)', async () => {
  // INP requires real user interactions (pointer events) to surface via the
  // Event Timing buffered observer in headless Chromium. Without synthesized
  // high-latency interaction handlers, the value stays null. The rating
  // thresholds themselves are unit-testable at the function level, but
  // exercising them through the MCP tool requires a real user input event
  // that produces a measurable duration — not reliably reproducible here.
  // Skipped with reason.
});

test('null-valued metrics do not crash the tool (empty-ish page)', async ({ client, server }) => {
  server.setContent('/', `<!doctype html><html><head></head><body></body></html>`, 'text/html');

  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  const metrics = await callPerf(client);

  // Metrics may be null; the contract is that the shape is present
  expect(metrics).toHaveProperty('inp');
  expect(metrics.inp).toHaveProperty('value');
  expect(metrics.inp).toHaveProperty('rating');
  // If inp is null, rating must also be null
  if (metrics.inp.value === null)
    expect(metrics.inp.rating).toBeNull();
});
