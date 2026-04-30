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

test('without acceptReload returns error requiring acknowledgment', async ({ client, server, mcpBrowser }) => {
  test.skip(mcpBrowser !== 'chrome' && mcpBrowser !== 'chromium', 'CSS coverage is Chromium-only');

  server.setContent('/', `
    <!doctype html>
    <html><head><style>.used { color: red; } .unused { color: blue; }</style></head>
    <body><div class="used">Hello</div></body></html>
  `, 'text/html');

  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });

  const raw = await client.callTool({
    name: 'uiux_css_coverage',
    arguments: {},
  });
  const parsed = parseResponse(raw);

  // Should surface an error / isError instead of running coverage
  expect(parsed?.error || raw.isError).toBeTruthy();
  const errText = (parsed?.error ?? '') + (raw.content?.[0] as any)?.text ?? '';
  expect(errText).toMatch(/acceptReload/);
});

test('with acceptReload: true returns used/total bytes', async ({ client, server, mcpBrowser }) => {
  test.skip(mcpBrowser !== 'chrome' && mcpBrowser !== 'chromium', 'CSS coverage is Chromium-only');

  server.setContent('/', `
    <!doctype html>
    <html><head><style>
      .used { color: red; font-weight: bold; }
      .unused { color: blue; padding: 10px; }
    </style></head>
    <body><div class="used">Hello</div></body></html>
  `, 'text/html');

  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });

  const raw = await client.callTool({
    name: 'uiux_css_coverage',
    arguments: { acceptReload: true },
  });
  const parsed = parseResponse(raw);
  expect(parsed?.result).toBeDefined();
  expect(raw.isError).toBeFalsy();

  const result = JSON.parse(parsed!.result!);
  expect(Array.isArray(result.stylesheets)).toBe(true);
  expect(result.summary).toBeDefined();
  expect(typeof result.summary.totalUsed).toBe('number');
  expect(typeof result.summary.totalUnused).toBe('number');

  for (const sheet of result.stylesheets) {
    expect(typeof sheet.url).toBe('string');
    expect(typeof sheet.usedBytes).toBe('number');
    expect(typeof sheet.totalBytes).toBe('number');
    expect(typeof sheet.percent).toBe('number');
    expect(sheet.usedBytes).toBeLessThanOrEqual(sheet.totalBytes);
  }
});

test('tool is registered with type action (reload acknowledged)', async ({ client, server, mcpBrowser }) => {
  test.skip(mcpBrowser !== 'chrome' && mcpBrowser !== 'chromium', 'CSS coverage is Chromium-only');

  // The way to probe this without exposing internals: request the tool list
  // and verify the description mentions the reload side-effect. The Phase 1
  // fix reclassified the tool from readOnly to action, and the reload
  // warning is part of that contract.
  const list = await client.listTools();
  const entry = list.tools.find((t: any) => t.name === 'uiux_css_coverage');
  expect(entry).toBeDefined();
  expect(entry!.description).toMatch(/reload/i);
});
