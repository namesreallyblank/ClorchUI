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

async function callCssVars(client: any, args: Record<string, any> = {}) {
  const raw = await client.callTool({ name: 'uiux_css_variables', arguments: args });
  const parsed = parseResponse(raw);
  expect(parsed?.result).toBeDefined();
  return JSON.parse(parsed!.result!);
}

test('extracts :root custom properties with values', async ({ client, server }) => {
  server.setContent('/', `
    <!doctype html>
    <html><head><style>
      :root { --lime: #C4F000; --blue: #3B82F6; --radius: 8px; }
      .card { background: var(--lime); border-radius: var(--radius); }
    </style></head>
    <body><div class="card">c</div></body></html>
  `, 'text/html');

  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  const result = await callCssVars(client);

  expect(Array.isArray(result.tokens)).toBe(true);
  const names = result.tokens.map((t: any) => t.name);
  expect(names).toContain('--lime');
  expect(names).toContain('--blue');
  expect(names).toContain('--radius');

  const lime = result.tokens.find((t: any) => t.name === '--lime');
  expect(lime).toBeDefined();
  expect(lime.value.toLowerCase()).toMatch(/#c4f000|rgb/);
  expect(typeof lime.selector).toBe('string');
  expect(typeof lime.source).toBe('string');

  expect(result.totalDefined).toBeGreaterThanOrEqual(3);
});

test('onlyRootScope filters out non-:root declarations', async ({ client, server }) => {
  server.setContent('/', `
    <!doctype html>
    <html><head><style>
      :root { --primary: #111; }
      .card { --card-bg: #fff; }
    </style></head>
    <body><div class="card">x</div></body></html>
  `, 'text/html');

  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  const scoped = await callCssVars(client, { onlyRootScope: true });
  const unscoped = await callCssVars(client, { onlyRootScope: false });

  const scopedNames = scoped.tokens.map((t: any) => t.name);
  expect(scopedNames).toContain('--primary');
  expect(scopedNames).not.toContain('--card-bg');

  const unscopedNames = unscoped.tokens.map((t: any) => t.name);
  expect(unscopedNames).toContain('--primary');
  expect(unscopedNames).toContain('--card-bg');
});

test('includeUsageAnalysis detects unused tokens and undefined references', async ({ client, server }) => {
  server.setContent('/', `
    <!doctype html>
    <html><head><style>
      :root { --used: #111; --unused: #222; }
      .a { color: var(--used); background: var(--ghost); }
    </style></head>
    <body><div class="a">x</div></body></html>
  `, 'text/html');

  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  const result = await callCssVars(client, { includeUsageAnalysis: true });

  expect(Array.isArray(result.unusedTokens)).toBe(true);
  expect(Array.isArray(result.undefinedReferenced)).toBe(true);

  expect(result.unusedTokens).toContain('--unused');
  expect(result.unusedTokens).not.toContain('--used');
  expect(result.undefinedReferenced).toContain('--ghost');
});

test('includeUsageAnalysis: false omits usage fields', async ({ client, server }) => {
  server.setContent('/', `
    <!doctype html>
    <html><head><style>:root { --a: #111; }</style></head>
    <body><div>x</div></body></html>
  `, 'text/html');

  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  const result = await callCssVars(client, { includeUsageAnalysis: false });

  expect(result.unusedTokens).toBeUndefined();
  expect(result.undefinedReferenced).toBeUndefined();
  expect(Array.isArray(result.tokens)).toBe(true);
});

test('skippedStylesheets exists (may be empty for same-origin)', async ({ client, server }) => {
  server.setContent('/', `
    <!doctype html>
    <html><head><style>:root { --x: red; }</style></head>
    <body></body></html>
  `, 'text/html');

  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  const result = await callCssVars(client);

  expect(Array.isArray(result.skippedStylesheets)).toBe(true);
  // All stylesheets on this page are same-origin / inline — no CORS failures expected
});
