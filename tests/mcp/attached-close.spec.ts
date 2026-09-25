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

import { test, expect } from './cli-fixtures';

// An attached browser belongs to another process, so disposing an MCP session must
// never close its context. The bound browser (--endpoint, the launcher's adopt path)
// is the case that breaks: closing its context closes it for the owner. Over
// --cdp-endpoint, closing the default context only drops the CDP connection, so a
// CDP variant of this test passes with or without the ownership guard.
test('browser_close over --endpoint leaves the bound browser context alive', async ({ boundBrowser, startClient, server }) => {
  const page = await boundBrowser.newPage();
  await page.goto(server.HELLO_WORLD);

  const { client } = await startClient({ args: ['--endpoint=default'] });
  expect(await client.callTool({ name: 'browser_snapshot' })).toHaveResponse({
    inlineSnapshot: expect.stringContaining('Hello, world!'),
  });

  // browser_close disposes the backend inside the call, so the dispose callback has
  // fully run by the time the response arrives.
  expect((await client.callTool({ name: 'browser_close' })).isError).toBeFalsy();

  expect(page.isClosed()).toBe(false);
  expect(await page.evaluate(() => document.body.textContent)).toContain('Hello, world!');
});
