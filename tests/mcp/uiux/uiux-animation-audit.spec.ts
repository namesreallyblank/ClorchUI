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

async function callAnim(client: any, args: Record<string, any> = {}) {
  const raw = await client.callTool({ name: 'uiux_animation_audit', arguments: args });
  const parsed = parseResponse(raw);
  expect(parsed?.result).toBeDefined();
  return JSON.parse(parsed!.result!);
}

test('detects declared CSS animation via @keyframes', async ({ client, server }) => {
  server.setContent('/', `
    <!doctype html>
    <html><head><style>
      @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      .spinner { animation: spin 2s linear infinite; width: 40px; height: 40px; background: red; }
    </style></head>
    <body><div class="spinner"></div></body></html>
  `, 'text/html');

  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  const result = await callAnim(client);

  expect(Array.isArray(result.declaredAnimations)).toBe(true);
  expect(result.declaredAnimations.length).toBeGreaterThan(0);

  const spinner = result.declaredAnimations.find((a: any) => a.name === 'spin');
  expect(spinner).toBeDefined();
  expect(spinner.selector).toMatch(/\.spinner/);
  expect(spinner.duration).toContain('2');
});

test('onlyActive: true returns only active animations, no declared arrays', async ({ client, server }) => {
  server.setContent('/', `
    <!doctype html>
    <html><head><style>
      @keyframes pulse { 0%,100% {opacity:1} 50% {opacity:.3} }
      .pulse { animation: pulse 1s ease-in-out infinite; }
    </style></head>
    <body><div class="pulse">x</div></body></html>
  `, 'text/html');

  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  const result = await callAnim(client, { onlyActive: true });

  expect(Array.isArray(result.activeAnimations)).toBe(true);
  // When onlyActive is true, declared* arrays are omitted entirely
  expect(result.declaredAnimations).toBeUndefined();
  expect(result.declaredTransitions).toBeUndefined();
});

test('reduced-motion override detected in reducedMotionSupport', async ({ client, server }) => {
  server.setContent('/', `
    <!doctype html>
    <html><head><style>
      @keyframes fade { from {opacity:0} to {opacity:1} }
      .fade { animation: fade 1s ease-in; }
      @media (prefers-reduced-motion: reduce) {
        .fade { transition: opacity 0.01s; }
      }
    </style></head>
    <body><div class="fade">hi</div></body></html>
  `, 'text/html');

  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  const result = await callAnim(client);

  expect(result.reducedMotionSupport).toBeDefined();
  expect(typeof result.reducedMotionSupport.declaredAnimations).toBe('number');
  expect(typeof result.reducedMotionSupport.overriddenForReducedMotion).toBe('number');
  expect(typeof result.reducedMotionSupport.coverage).toBe('number');

  // We declared one animation rule and one override → coverage > 0
  expect(result.reducedMotionSupport.overriddenForReducedMotion).toBeGreaterThan(0);
  expect(result.reducedMotionSupport.coverage).toBeGreaterThan(0);
});

test('declaredTransitions populated when includeTransitions: true', async ({ client, server }) => {
  server.setContent('/', `
    <!doctype html>
    <html><head><style>
      .btn { transition: background-color 0.3s ease; background: #111; color: #fff; padding: 8px 12px; }
      .btn:hover { background: #333; }
    </style></head>
    <body><button class="btn">Click</button></body></html>
  `, 'text/html');

  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  const withTrans = await callAnim(client, { includeTransitions: true });
  const withoutTrans = await callAnim(client, { includeTransitions: false });

  expect(Array.isArray(withTrans.declaredTransitions)).toBe(true);
  expect(withTrans.declaredTransitions.length).toBeGreaterThan(0);

  const btn = withTrans.declaredTransitions.find((t: any) => t.selector.includes('.btn'));
  expect(btn).toBeDefined();
  expect(btn.property).toContain('background-color');

  // When includeTransitions is false, declaredTransitions should be omitted
  expect(withoutTrans.declaredTransitions).toBeUndefined();
});

test('currentPreference reflects matchMedia state', async ({ client, server }) => {
  server.setContent('/', `
    <!doctype html>
    <html><head></head><body>ok</body></html>
  `, 'text/html');

  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  const result = await callAnim(client);

  expect(result.currentPreference).toBeDefined();
  expect(['reduce', 'no-preference']).toContain(result.currentPreference);
});
