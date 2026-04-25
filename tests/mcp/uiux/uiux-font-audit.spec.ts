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

async function callFontAudit(client: any) {
  const raw = await client.callTool({ name: 'uiux_font_audit', arguments: {} });
  const parsed = parseResponse(raw);
  expect(parsed?.result).toBeDefined();
  return JSON.parse(parsed!.result!);
}

test('aggregates fonts, sizes, weights across page', async ({ client, server }) => {
  server.setContent('/', `
    <!doctype html>
    <html><head><style>
      body { font-family: Arial, sans-serif; }
      .alt { font-family: "Courier New", monospace; font-size: 20px; }
      h1 { font-size: 32px; font-weight: 700; }
      p { font-size: 14px; }
    </style></head>
    <body>
      <h1>Title</h1>
      <p>Body text</p>
      <p class="alt">Alt text</p>
    </body></html>
  `, 'text/html');

  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  const result = await callFontAudit(client);

  expect(Array.isArray(result.fonts)).toBe(true);
  expect(result.fonts.length).toBeGreaterThanOrEqual(2);
  expect(typeof result.totalElements).toBe('number');
  expect(result.totalElements).toBeGreaterThan(0);

  const families = result.fonts.map((f: any) => f.family);
  expect(families.some((f: string) => f.toLowerCase().includes('arial'))).toBe(true);
  expect(families.some((f: string) => f.toLowerCase().includes('courier'))).toBe(true);

  // Sorted by count desc
  for (let i = 1; i < result.fonts.length; i++)
    expect(result.fonts[i - 1].count).toBeGreaterThanOrEqual(result.fonts[i].count);

  for (const font of result.fonts) {
    expect(typeof font.family).toBe('string');
    expect(Array.isArray(font.sizes)).toBe(true);
    expect(Array.isArray(font.weights)).toBe(true);
    expect(font.sizes.length).toBeGreaterThan(0);
  }
});

test('lineHeights array is present (Phase 1 regression)', async ({ client, server }) => {
  server.setContent('/', `
    <!doctype html>
    <html><head><style>
      body { font-family: Arial; line-height: 1.5; }
      p { line-height: 24px; }
      h1 { line-height: 1.2; font-size: 32px; }
    </style></head>
    <body>
      <h1>Title</h1>
      <p>Body</p>
      <p>More body</p>
    </body></html>
  `, 'text/html');

  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  const result = await callFontAudit(client);

  // Every font entry must include a lineHeights array
  for (const font of result.fonts) {
    expect(font).toHaveProperty('lineHeights');
    expect(Array.isArray(font.lineHeights)).toBe(true);
  }

  // At least one font entry should have non-empty lineHeights
  const anyHasLineHeights = result.fonts.some((f: any) => f.lineHeights.length > 0);
  expect(anyHasLineHeights).toBe(true);
});

test('caps lineHeights at 5 distinct values per family', async ({ client, server }) => {
  // Build a page that produces >5 distinct computed line-heights on the same
  // font family. Numeric line-heights are emitted as computed pixels by the
  // browser, so each unique font-size*1.N combination counts as distinct.
  const items = Array.from({ length: 10 }, (_, i) => {
    const fs = 10 + i; // 10, 11, 12, ..., 19
    const lh = 1 + i * 0.05; // 1.0, 1.05, ..., 1.45
    return `<p style="font-family: Arial, sans-serif; font-size: ${fs}px; line-height: ${lh}">Row ${i}</p>`;
  }).join('\n');

  server.setContent('/', `<!doctype html><html><body>${items}</body></html>`, 'text/html');

  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  const result = await callFontAudit(client);

  const arial = result.fonts.find((f: any) => f.family.toLowerCase().includes('arial'));
  expect(arial).toBeDefined();
  expect(arial.lineHeights.length).toBeLessThanOrEqual(5);
});
