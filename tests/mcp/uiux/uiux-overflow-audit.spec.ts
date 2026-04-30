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

async function callOverflow(client: any, args: Record<string, any> = {}) {
  const raw = await client.callTool({ name: 'uiux_overflow_audit', arguments: args });
  const parsed = parseResponse(raw);
  expect(parsed?.result).toBeDefined();
  return JSON.parse(parsed!.result!);
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

// Use min-width on body so overflow is unambiguous regardless of initial
// viewport size at test start. A larger settle time keeps the test stable
// when multiple MCP workers are contending for CPU.
const WIDE_SETTLE = 400;

test('detects elements exceeding narrow viewport width', async ({ client, server }) => {
  server.setContent('/', `
    <!doctype html>
    <html><head><style>
      html, body { margin: 0; }
      body { min-width: 2000px; }
      .wide { width: 2000px; height: 40px; background: red; }
    </style></head>
    <body><div class="wide" id="too-wide"></div></body></html>
  `, 'text/html');

  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  const result = await callOverflow(client, { viewports: [375, 2400], settleTimeMs: WIDE_SETTLE });

  expect(Array.isArray(result.viewports)).toBe(true);
  expect(result.viewports).toHaveLength(2);

  const narrow = result.viewports.find((v: any) => v.width === 375);
  expect(narrow).toBeDefined();
  expect(narrow.offenders.length).toBeGreaterThan(0);

  const offender = narrow.offenders[0];
  expect(typeof offender.selector).toBe('string');
  expect(typeof offender.excessPx).toBe('number');
  expect(offender.excessPx).toBeGreaterThan(0);
  expect(['viewport', 'self']).toContain(offender.overflow);

  // At a 2400px viewport the 2000px content fits
  const wideVp = result.viewports.find((v: any) => v.width === 2400);
  expect(wideVp.offenders.length).toBe(0);
});

test('narrow content produces no offenders and no global horizontal scroll', async ({ client, server }) => {
  server.setContent('/', `
    <!doctype html>
    <html><head><style>
      html, body { margin: 0; }
      .ok { width: 100px; height: 20px; background: green; }
    </style></head>
    <body><div class="ok"></div></body></html>
  `, 'text/html');

  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  const result = await callOverflow(client, { viewports: [375, 768], settleTimeMs: WIDE_SETTLE });

  for (const vp of result.viewports) {
    expect(vp.offenders).toHaveLength(0);
    expect(vp.globalHorizontalScroll).toBe(false);
  }
  expect(result.summary.totalOffenders).toBe(0);
});

test('restores viewport size after audit', async ({ client, server }) => {
  server.setContent('/', `<!doctype html><html><body></body></html>`, 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });

  // Explicitly set viewport so the tool has an originalViewport to restore.
  // Without this, page.viewportSize() can be null and restore is a no-op.
  const targetWidth = 900;
  const targetHeight = 700;
  await client.callTool({
    name: 'browser_resize',
    arguments: { width: targetWidth, height: targetHeight },
  });

  const before = await evalViewportWidth(client);
  await callOverflow(client, { viewports: [375, 1440], settleTimeMs: WIDE_SETTLE });
  const after = await evalViewportWidth(client);

  expect(before).toBe(targetWidth);
  expect(after).toBe(targetWidth);
});

test('caps offender list at 20 entries per viewport', async ({ client, server }) => {
  // Generate 30 very wide elements inside a forced-wide body
  const rows = Array.from({ length: 30 }, (_, i) =>
    `<div style="width:2000px;height:10px;background:red" id="d${i}"></div>`
  ).join('');

  server.setContent('/', `
    <!doctype html>
    <html><head><style>html,body{margin:0}body{min-width:2000px}</style></head>
    <body>${rows}</body></html>
  `, 'text/html');

  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  const result = await callOverflow(client, { viewports: [375], settleTimeMs: WIDE_SETTLE });

  const narrow = result.viewports[0];
  expect(narrow.offenders.length).toBeLessThanOrEqual(20);
});

test('summary reports totalOffenders and worstViewport', async ({ client, server }) => {
  server.setContent('/', `
    <!doctype html>
    <html><head><style>
      html, body { margin: 0; }
      body { min-width: 2000px; }
      .w { width: 2000px; height: 20px; background: red; }
    </style></head>
    <body><div class="w"></div></body></html>
  `, 'text/html');

  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  const result = await callOverflow(client, { viewports: [375, 768], settleTimeMs: WIDE_SETTLE });

  expect(result.summary).toBeDefined();
  expect(typeof result.summary.totalOffenders).toBe('number');
  expect(result.summary.totalOffenders).toBeGreaterThan(0);
  expect([375, 768]).toContain(result.summary.worstViewport);
});
