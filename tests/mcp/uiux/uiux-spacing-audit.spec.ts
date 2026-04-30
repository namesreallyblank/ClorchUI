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

async function callSpacing(client: any, args: Record<string, any> = {}) {
  const raw = await client.callTool({ name: 'uiux_spacing_audit', arguments: args });
  const parsed = parseResponse(raw);
  expect(parsed?.result).toBeDefined();
  return JSON.parse(parsed!.result!);
}

test('all 8px-multiple spacings → complianceRate 1 and zero violations', async ({ client, server }) => {
  server.setContent('/', `
    <!doctype html>
    <html><head><style>
      body { margin: 0; padding: 0; }
      .a { padding: 8px; margin: 16px; width: 100px; height: 20px; }
      .b { padding: 24px 8px; margin-top: 32px; width: 100px; height: 20px; }
    </style></head>
    <body>
      <div class="a">A</div>
      <div class="b">B</div>
    </body></html>
  `, 'text/html');

  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  const result = await callSpacing(client, { baseUnit: 8, tolerance: 0 });

  expect(result.complianceRate).toBe(1);
  expect(result.totalViolations).toBe(0);
  expect(result.topViolators).toEqual([]);
});

test('non-multiple padding produces violation with expectedMultiples', async ({ client, server }) => {
  server.setContent('/', `
    <!doctype html>
    <html><head><style>
      body { margin: 0; padding: 0; }
      .bad { padding: 14px; width: 100px; height: 20px; }
    </style></head>
    <body><div class="bad">X</div></body></html>
  `, 'text/html');

  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  const result = await callSpacing(client, { baseUnit: 8, tolerance: 0 });

  expect(result.totalViolations).toBeGreaterThan(0);
  expect(result.complianceRate).toBeLessThan(1);

  const bad = result.topViolators.find((v: any) => v.selector.includes('.bad'));
  expect(bad).toBeDefined();

  const v14 = bad.violations.find((x: any) => x.value === 14);
  expect(v14).toBeDefined();
  expect(v14.expectedMultiples).toEqual([8, 16]);
  expect(v14.property).toMatch(/padding-/);
});

test('tolerance: 2 allows 14px against base 8', async ({ client, server }) => {
  server.setContent('/', `
    <!doctype html>
    <html><head><style>
      body { margin: 0; padding: 0; }
      .e { padding: 14px; width: 100px; height: 20px; }
    </style></head>
    <body><div class="e">X</div></body></html>
  `, 'text/html');

  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  const strict = await callSpacing(client, { baseUnit: 8, tolerance: 0 });
  const lenient = await callSpacing(client, { baseUnit: 8, tolerance: 2 });

  // Strict: 14 violates (distance 2 from 16)
  expect(strict.totalViolations).toBeGreaterThan(0);
  // Lenient: tolerance 2 — distance 2 is accepted
  const lenientViolators = lenient.topViolators.filter((v: any) => v.selector.includes('.e'));
  expect(lenientViolators).toEqual([]);
});

test('baseUnit: 4 — value 14 still fails (distance 2 from 12 or 16)', async ({ client, server }) => {
  server.setContent('/', `
    <!doctype html>
    <html><head><style>
      body { margin: 0; padding: 0; }
      .e { padding: 14px; width: 100px; height: 20px; }
    </style></head>
    <body><div class="e">X</div></body></html>
  `, 'text/html');

  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  const result = await callSpacing(client, { baseUnit: 4, tolerance: 0 });

  // 14 % 4 = 2, distance = min(2, 2) = 2 > tolerance 0 → violation
  const bad = result.topViolators.find((v: any) => v.selector.includes('.e'));
  expect(bad).toBeDefined();
  const v14 = bad.violations.find((x: any) => x.value === 14);
  expect(v14).toBeDefined();
  expect(v14.expectedMultiples).toEqual([12, 16]);
  expect(result.baseUnit).toBe(4);
});

test('gap is only counted on flex/grid parents, not on random divs', async ({ client, server }) => {
  server.setContent('/', `
    <!doctype html>
    <html><head><style>
      body { margin: 0; padding: 0; }
      .flex-parent { display: flex; gap: 7px; }
      .block-parent { display: block; gap: 7px; }
      .item { width: 40px; height: 40px; background: #eee; }
    </style></head>
    <body>
      <div class="flex-parent">
        <div class="item">A</div><div class="item">B</div>
      </div>
      <div class="block-parent">
        <div class="item">C</div><div class="item">D</div>
      </div>
    </body></html>
  `, 'text/html');

  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  const result = await callSpacing(client, { baseUnit: 8, tolerance: 0, properties: ['gap'] });

  // 7px gap on flex parent → violation; 7px gap on block parent → ignored
  const flex = result.topViolators.find((v: any) => v.selector.includes('flex-parent'));
  const block = result.topViolators.find((v: any) => v.selector.includes('block-parent'));

  expect(flex).toBeDefined();
  expect(block).toBeUndefined();
  expect(result.violationsByProperty.gap).toBeGreaterThan(0);
});

test('baseUnit <= 0 returns validation error', async ({ client, server }) => {
  server.setContent('/', `<!doctype html><html><body></body></html>`, 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });

  const raw = await client.callTool({
    name: 'uiux_spacing_audit',
    arguments: { baseUnit: 0 },
  });
  const parsed = parseResponse(raw);
  const errText = (parsed?.error ?? '') + (raw.content?.[0] as any)?.text ?? '';
  expect(errText).toMatch(/baseUnit must be greater than 0/);
});
