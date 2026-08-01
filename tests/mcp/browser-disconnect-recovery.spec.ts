/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { test, expect } from './fixtures';

// Forces the exact wedge described in the "permanent-wedge" defect: the browser this
// MCP session is bound to dies out from under it (here: the test itself kills it via
// a CDP-attached connection, standing in for a shared browser-server socket dying).
// Verifies (1) the session fails fast with a stable BROWSER_DISCONNECTED signal instead
// of looping on raw TargetClosedError text forever, and (2) a completely independent
// sibling session is unaffected -- proving nothing shared was touched during recovery.
test('browser death produces a stable BROWSER_DISCONNECTED error, not a permanent generic wedge', async ({ cdpServer, startClient, server }) => {
  const browserContext = await cdpServer.start();
  const { client } = await startClient({ args: [`--cdp-endpoint=${cdpServer.endpoint}`] });

  // Sibling: a fully independent client with its own isolated browser, alive for the
  // whole test, to prove the dying session's recovery path never touches shared state.
  const { client: sibling } = await startClient({ args: ['--isolated'] });

  // 1. Confirm the session works before the browser dies.
  const before = await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.HELLO_WORLD },
  });
  expect(before.isError).toBeFalsy();

  // 2. Force the failure: kill the browser this session is bound to. For a CDP-attached
  // persistent context, closing the context kills the whole browser process, which is
  // exactly the "dead BROWSER SERVER" case the fix targets (not a scoped dead target).
  await browserContext.close();

  // Give the client-side Connection a beat to observe the transport closing and flip
  // Browser.isConnected() to false (this is event-driven, not synchronous with close()).
  await expect(async () => {
    const result: any = await client.callTool({
      name: 'browser_navigate',
      arguments: { url: server.HELLO_WORLD },
    });
    expect(result.isError).toBe(true);
    const text = result.content?.[0]?.text ?? '';
    expect(text).toContain('BROWSER_DISCONNECTED');
  }).toPass({ timeout: 10_000 });

  // 3. Deny-side: the FIRST call after death must be a clean, actionable signal -- not a
  // raw stringified TargetClosedError/stack trace. This is the "actionable, not masked"
  // half of the requirement.
  const afterDeath = await client.callTool({
    name: 'browser_click',
    arguments: { element: 'anything', target: 'f0' },
  }) as any;
  expect(afterDeath.isError).toBe(true);
  expect(afterDeath.content?.[0]?.text ?? '').toContain('BROWSER_DISCONNECTED');
  expect(afterDeath.content?.[0]?.text ?? '').not.toContain('TargetClosedError');

  // 4. Allow-side (sibling isolation): the independent session must be completely
  // unaffected -- still able to navigate normally after the other session's browser died.
  const siblingResult = await sibling.callTool({
    name: 'browser_navigate',
    arguments: { url: server.HELLO_WORLD },
  }) as any;
  expect(siblingResult.isError).toBeFalsy();
});
