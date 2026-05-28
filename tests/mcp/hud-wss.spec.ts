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

// Regression guard for the HUD mixed-content bug: an insecure ws:// client
// dialed from an HTTPS top-level origin is blocked by Chromium as mixed
// active content (the handshake silently stalls — no CSP error, no JS throw).
// The HUD now serves over wss:// with a self-signed loopback cert, accepted
// via contextOptions.ignoreHTTPSErrors. This test asserts the in-page client
// actually reaches OPEN on an HTTPS page — not merely that browser_hud_open
// returns "ready" (that assertion is server-side-only and false-positives on
// HTTPS).
test('HUD ws reaches OPEN on an HTTPS page (mixed-content regression)', async ({ startClient, httpsServer }) => {
  httpsServer.setContent('/', `<title>HUD HTTPS</title><body>HUD over TLS</body>`, 'text/html');

  // ignoreHTTPSErrors is what lets Chromium accept the HUD's self-signed
  // loopback cert for the in-page wss:// connection.
  const { client } = await startClient({
    config: { browser: { contextOptions: { ignoreHTTPSErrors: true } } },
  });

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: httpsServer.PREFIX },
  });

  await client.callTool({ name: 'browser_hud_open', arguments: {} });

  // Poll the client-exposed isConnected() until the in-page wss:// socket is
  // OPEN. On the old ws:// build this never flips true on an HTTPS origin.
  await expect.poll(async () => {
    const result = await client.callTool({
      name: 'browser_evaluate',
      arguments: {
        function: '() => Boolean(window.__clorchHud && window.__clorchHud.isConnected())',
      },
    });
    return JSON.stringify(result);
  }, { timeout: 15000 }).toContain('true');
});
