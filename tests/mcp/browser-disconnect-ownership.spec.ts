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

import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';

import { test, expect } from './fixtures';

// After the browser dies, reconnect behaviour depends on who owns it:
// - attached (--cdp-endpoint / --endpoint): reconnect, as upstream does.
// - own, in a persistent profile slot claimed by the ClorchUI launcher: relaunch only
//   while that launcher still holds the claim; otherwise fail with BROWSER_DISCONNECTED.
//
// The launcher (bin/clorchui-launcher.mjs) claims a slot by writing its own pid to
// <slot>/.clorchui-slot.lock/pid and then spawns the MCP server as its direct child.
// Here the test worker plays the launcher: it is the server's parent process.

async function writeSlotClaim(slotDir: string, pid: number) {
  const lockDir = path.join(slotDir, '.clorchui-slot.lock');
  await fs.promises.mkdir(lockDir, { recursive: true });
  await fs.promises.writeFile(path.join(lockDir, 'pid'), String(pid));
}

// Chrome's SingletonLock is a symlink to "<host>-<pid>"; lstat sees it even though
// the target does not exist as a file.
async function isSlotLocked(slotDir: string) {
  return await fs.promises.lstat(path.join(slotDir, 'SingletonLock')).then(() => true, () => false);
}

async function assertPortFree(port: number) {
  // Never let Browser.close below reach a browser this test did not start.
  const inUse = await fetch(`http://localhost:${port}/json/version`).then(() => true, () => false);
  if (inUse)
    throw new Error(`Port ${port} is already in use; refusing to run a test that kills the browser behind it.`);
}

async function killBrowserOverCDP(port: number) {
  const cdpBrowser = await chromium.connectOverCDP(`http://localhost:${port}`);
  const session = await cdpBrowser.newBrowserCDPSession();
  await session.send('Browser.close').catch(() => {});
}

test('attached browser reconnects even after the slot claim moves to a sibling', async ({ cdpServer, startClient, server }, testInfo) => {
  const slotDir = testInfo.outputPath('slot');
  await writeSlotClaim(slotDir, process.pid);
  const browserContext = await cdpServer.start();
  const { client, stderr } = await startClient({
    args: [`--cdp-endpoint=${cdpServer.endpoint}`],
    env: { DEBUG: 'pw:mcp:backend', PLAYWRIGHT_MCP_USER_DATA_DIR: slotDir },
  });

  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.HELLO_WORLD },
  })).toHaveResponse({
    snapshot: expect.stringContaining('Hello, world!'),
  });

  await browserContext.close();
  await expect.poll(() => stderr()).toContain('browser disconnected');
  await writeSlotClaim(slotDir, process.pid + 1);
  await cdpServer.start();

  // The claim only governs browsers this server launched itself.
  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.HELLO_WORLD },
  })).toHaveResponse({
    snapshot: expect.stringContaining('Hello, world!'),
  });
});

test('own browser relaunches while the launcher still holds the slot claim', async ({ startClient, server, mcpBrowser }, testInfo) => {
  test.skip(!['chrome', 'msedge', 'chromium'].includes(mcpBrowser!), 'The test kills the browser over CDP');

  const slotDir = testInfo.outputPath('slot');
  await writeSlotClaim(slotDir, process.pid);
  const port = 9600 + testInfo.workerIndex;
  await assertPortFree(port);
  const { client, stderr } = await startClient({
    config: { browser: { launchOptions: { args: [`--remote-debugging-port=${port}`] } } },
    env: { DEBUG: 'pw:mcp:backend', PLAYWRIGHT_MCP_USER_DATA_DIR: slotDir },
  });

  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.HELLO_WORLD },
  })).toHaveResponse({
    snapshot: expect.stringContaining('Hello, world!'),
  });

  await killBrowserOverCDP(port);
  await expect.poll(() => stderr()).toContain('browser disconnected');

  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.HELLO_WORLD },
  })).toHaveResponse({
    snapshot: expect.stringContaining('Hello, world!'),
  });
  expect(await isSlotLocked(slotDir)).toBe(true);
});

test('own browser returns BROWSER_DISCONNECTED once the launcher lost the slot claim', async ({ startClient, server, mcpBrowser }, testInfo) => {
  test.skip(!['chrome', 'msedge', 'chromium'].includes(mcpBrowser!), 'The test kills the browser over CDP');

  const slotDir = testInfo.outputPath('slot');
  await writeSlotClaim(slotDir, process.pid);
  const port = 9600 + testInfo.workerIndex;
  await assertPortFree(port);
  const { client, stderr } = await startClient({
    config: { browser: { launchOptions: { args: [`--remote-debugging-port=${port}`] } } },
    env: { DEBUG: 'pw:mcp:backend', PLAYWRIGHT_MCP_USER_DATA_DIR: slotDir },
  });

  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.HELLO_WORLD },
  })).toHaveResponse({
    snapshot: expect.stringContaining('Hello, world!'),
  });

  await killBrowserOverCDP(port);
  await expect.poll(() => stderr()).toContain('browser disconnected');
  await expect.poll(() => isSlotLocked(slotDir)).toBe(false);

  // A sibling launcher reaped the dead slot and claimed it for itself.
  await writeSlotClaim(slotDir, process.pid + 1);
  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.HELLO_WORLD },
  })).toHaveResponse({
    error: expect.stringContaining('BROWSER_DISCONNECTED'),
    isError: true,
  });
  expect(await isSlotLocked(slotDir)).toBe(false);

  // A sweep reaped the claim without re-claiming it: still not ours.
  await fs.promises.rm(path.join(slotDir, '.clorchui-slot.lock'), { recursive: true });
  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.HELLO_WORLD },
  })).toHaveResponse({
    error: expect.stringContaining('BROWSER_DISCONNECTED'),
    isError: true,
  });
  expect(await isSlotLocked(slotDir)).toBe(false);
});
