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

import * as z from 'zod';

import { defineTool, defineTabTool } from './tool';
import { ensureHudServer, getHudServer } from './hudServer';
import { hudClientScript } from './hudClient';

const hudOpen = defineTabTool({
  capability: 'core',

  schema: {
    name: 'browser_hud_open',
    title: 'Open the Clorch HUD',
    description: 'Start the in-page Clorch HUD (element picker + message box). Ensures the local WebSocket server is running and the HUD client is injected into the current page. After calling this, press Ctrl/Cmd+Shift+K in the browser to pick an element and send a message.',
    inputSchema: z.object({}),
    type: 'action',
  },

  handle: async (tab, params, response) => {
    const browserContext = tab.page.context();
    // Idempotently start the WS server + register the always-on init script.
    const port = await tab.context.ensureHudInjected(browserContext);
    // Convenience: also inject into the CURRENT page immediately, in case it
    // was loaded before the init script was registered. The client guards
    // against double-install via window.__clorchHudInstalled.
    await tab.page.evaluate(hudClientScript, { port });
    response.addTextResult(
        `Clorch HUD ready on wss://127.0.0.1:${port}. ` +
        `Press Ctrl/Cmd+Shift+K in the browser to pick an element, type a message, and press Enter. ` +
        `Call browser_hud_watch to receive messages in realtime.`);
  },
});

const hudWatch = defineTool({
  capability: 'core',

  schema: {
    name: 'browser_hud_watch',
    title: 'Watch for a Clorch HUD message',
    description: 'Wait (long-poll) for the next message sent from the in-page Clorch HUD. Returns the message and the selected element details as JSON. Drains any already-queued messages first. Re-call to keep watching after a timeout.',
    inputSchema: z.object({
      timeout: z.number().optional().describe('Seconds to wait for a HUD message before returning. Defaults to 60.'),
    }),
    type: 'readOnly',
  },

  handle: async (context, params, response) => {
    const server = await ensureHudServer(context.options.cwd);
    const timeoutMs = Math.max(1000, Math.round((params.timeout ?? 60) * 1000));

    // Drain anything already queued so nothing is missed between calls.
    const queued = server.drainQueued();
    if (queued.length) {
      response.addTextResult(JSON.stringify(queued[0]));
      return;
    }

    const message = await server.waitForMessage(timeoutMs);
    if (message)
      response.addTextResult(JSON.stringify(message));
    else
      response.addTextResult(`No HUD message within ${Math.round(timeoutMs / 1000)}s — call browser_hud_watch again to keep watching.`);
  },
});

const hudClose = defineTabTool({
  capability: 'core',

  schema: {
    name: 'browser_hud_close',
    title: 'Close the Clorch HUD',
    description: 'Hide the in-page Clorch HUD panel and disable the element picker on the current page. The WebSocket channel stays alive; re-open with browser_hud_open.',
    inputSchema: z.object({}),
    type: 'action',
  },

  handle: async (tab, params, response) => {
    const server = getHudServer();
    if (!server) {
      response.addTextResult('Clorch HUD is not running.');
      return;
    }
    await tab.page.evaluate(() => {
      const hud = (window as any).__clorchHud;
      if (hud) {
        if (typeof hud.closePanel === 'function')
          hud.closePanel();
      }
    });
    response.addTextResult('Clorch HUD panel closed and picker disabled on the current page.');
  },
});

export default [
  hudOpen,
  hudWatch,
  hudClose,
];
