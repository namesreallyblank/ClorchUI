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

test('runs axe-core and returns violations array on a normal page', async ({ client, server }) => {
  // A minimal page with a known a11y issue (image without alt text)
  server.setContent('/', `
    <!doctype html>
    <html lang="en"><head><title>Test</title></head>
    <body>
      <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=">
      <button></button>
    </body></html>
  `, 'text/html');

  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });

  const raw = await client.callTool({
    name: 'uiux_accessibility_audit',
    arguments: {},
  });
  const parsed = parseResponse(raw);
  expect(parsed?.result).toBeDefined();

  const result = JSON.parse(parsed!.result!);

  // Either axe ran successfully and returned violations+passes,
  // OR CSP/network blocked injection and returned structured error.
  if (result.error === 'csp_blocked') {
    // On network failure we may still land here in CI — valid structured error
    expect(result.message).toMatch(/AXE-CORE INJECTION FAILED/);
  } else {
    expect(Array.isArray(result.violations)).toBe(true);
    expect(typeof result.passes).toBe('number');
  }
});

test('CSP-restricted page returns structured csp_blocked error', async ({ client, server }) => {
  // A strict CSP that disallows external scripts
  server.setContent('/', `
    <!doctype html>
    <html><head>
      <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'">
      <title>CSP Test</title>
    </head><body><p>Blocked</p></body></html>
  `, 'text/html');

  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });

  const raw = await client.callTool({
    name: 'uiux_accessibility_audit',
    arguments: {},
  });
  const parsed = parseResponse(raw);
  expect(parsed?.result).toBeDefined();

  const result = JSON.parse(parsed!.result!);

  expect(result).toHaveProperty('error', 'csp_blocked');
  expect(result).toHaveProperty('message');
  expect(result).toHaveProperty('detail');
  expect(result).toHaveProperty('axeCoreUrl');
  expect(typeof result.message).toBe('string');
  expect(result.message).toMatch(/AXE-CORE INJECTION FAILED/);
  // Must mention workarounds
  expect(result.message).toMatch(/Workarounds/);
  expect(result.message).toMatch(/AXE_CORE_URL/);
});

test('AXE_CORE_URL env var override is applied to the error payload', async ({ startClient, server }) => {
  const customUrl = 'http://127.0.0.1:1/custom-axe.js';
  const { client } = await startClient({
    env: {
      AXE_CORE_URL: customUrl,
    },
  });

  server.setContent('/', `
    <!doctype html>
    <html><head>
      <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'">
    </head><body><p>x</p></body></html>
  `, 'text/html');

  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });

  const raw = await client.callTool({
    name: 'uiux_accessibility_audit',
    arguments: {},
  });
  const parsed = parseResponse(raw);
  const result = JSON.parse(parsed!.result!);

  // Custom URL should surface in the error payload (CSP blocks it)
  expect(result.axeCoreUrl).toBe(customUrl);
});
