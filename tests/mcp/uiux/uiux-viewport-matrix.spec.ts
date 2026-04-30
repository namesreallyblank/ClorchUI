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

async function callMatrix(client: any, args: Record<string, any> = {}) {
  const raw = await client.callTool({ name: 'uiux_viewport_matrix', arguments: args });
  const parsed = parseResponse(raw);
  expect(parsed?.result).toBeDefined();
  return { parsed, result: JSON.parse(parsed!.result!) };
}

async function evalViewportWidth(client: any): Promise<number | null> {
  const raw = await client.callTool({
    name: 'browser_evaluate',
    arguments: { function: '() => window.innerWidth' },
  });
  const parsed = parseResponse(raw);
  if (!parsed?.result) return null;
  const n = Number(parsed.result.trim());
  return Number.isFinite(n) ? n : null;
}

const WIDE_SETTLE = 400;

test('default 4 viewports produce 4 entries with shape', async ({ client, server }) => {
  server.setContent('/', `<!doctype html><html><body><p>ok</p></body></html>`, 'text/html');

  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  const { result } = await callMatrix(client, { settleTimeMs: WIDE_SETTLE });

  expect(Array.isArray(result.viewports)).toBe(true);
  expect(result.viewports.length).toBe(4);
  expect(result.viewports.map((v: any) => v.width).sort((a: number, b: number) => a - b))
    .toEqual([375, 768, 1024, 1440]);

  for (const vp of result.viewports) {
    expect(typeof vp.width).toBe('number');
    expect(typeof vp.height).toBe('number');
    expect(vp.documentDimensions).toBeDefined();
    expect(typeof vp.hasHorizontalScroll).toBe('boolean');
    expect(vp.layoutBreaks).toBeDefined();
    expect(typeof vp.layoutBreaks.count).toBe('number');
    expect(Array.isArray(vp.layoutBreaks.topSelectors)).toBe(true);
    expect(typeof vp.fontSizeDistribution).toBe('object');
    expect(typeof vp.cumulativeLayoutShift).toBe('number');
    expect(typeof vp.visibleImages).toBe('number');
    expect(typeof vp.interactivesBelowFold).toBe('number');
  }
});

test('layoutBreaks and summary.viewportsWithBreaks detect wide content', async ({ client, server }) => {
  // Force body min-width so overflow is unambiguous at any narrow viewport.
  // layoutBreaks uses rect.right > vw, which is deterministic once the
  // viewport is set and the page reflows.
  server.setContent('/', `
    <!doctype html>
    <html><head><style>
      html, body { margin: 0; }
      body { min-width: 2000px; }
      .wide { width: 2000px; height: 20px; background: red; }
    </style></head>
    <body><div class="wide"></div></body></html>
  `, 'text/html');

  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  const { result } = await callMatrix(client, { viewports: [375, 2400], settleTimeMs: WIDE_SETTLE });

  const narrow = result.viewports.find((v: any) => v.width === 375);
  expect(narrow.layoutBreaks.count).toBeGreaterThan(0);
  expect(narrow.layoutBreaks.topSelectors.length).toBeGreaterThan(0);

  expect(result.summary.viewportsWithBreaks).toContain(375);
});

test('summary.worstCLS aggregates max CLS across viewports', async ({ client, server }) => {
  server.setContent('/', `<!doctype html><html><body>ok</body></html>`, 'text/html');

  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  const { result } = await callMatrix(client, { viewports: [375, 1024], settleTimeMs: WIDE_SETTLE });

  expect(typeof result.summary.worstCLS).toBe('number');
  const maxPerViewport = Math.max(...result.viewports.map((v: any) => v.cumulativeLayoutShift));
  expect(result.summary.worstCLS).toBe(maxPerViewport);
});

test('captureScreenshot: true without vision capability returns helpful error', async ({ client, server }) => {
  server.setContent('/', `<!doctype html><html><body>ok</body></html>`, 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });

  const raw = await client.callTool({
    name: 'uiux_viewport_matrix',
    arguments: { captureScreenshot: true, viewports: [375], settleTimeMs: 50 },
  });
  const parsed = parseResponse(raw);

  // Either an error section is emitted, or isError is set; the message should
  // mention vision capability.
  const errText = (parsed?.error ?? '') + ((raw.content?.[0] as any)?.text ?? '');
  expect(errText).toMatch(/vision/i);
});

test('restores viewport size after analysis', async ({ client, server }) => {
  server.setContent('/', `<!doctype html><html><body>ok</body></html>`, 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });

  // Explicitly set viewport so the tool has an originalViewport to restore.
  const targetWidth = 900;
  const targetHeight = 700;
  await client.callTool({
    name: 'browser_resize',
    arguments: { width: targetWidth, height: targetHeight },
  });

  const before = await evalViewportWidth(client);
  await callMatrix(client, { viewports: [375, 1440], settleTimeMs: WIDE_SETTLE });
  const after = await evalViewportWidth(client);

  expect(before).toBe(targetWidth);
  expect(after).toBe(targetWidth);
});
