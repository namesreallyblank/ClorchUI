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

import path from 'path';

import * as playwright from 'playwright-core';
import { SharedBrowserManager } from './sharedBrowserManager';
import { logUnhandledError, testDebug } from '../log';

import type { FullConfig } from './config';
import type { BrowserContextFactory, BrowserContextFactoryResult, HeadlessOption } from './browserContextFactory';
import type { ClientInfo } from '../sdk/server';
import type { BrowserContextOptions } from '../../../../playwright-core/src/client/types';

type CreateContextOptions = HeadlessOption & {
  toolName?: string;
};

export class SharedBrowserContextFactory implements BrowserContextFactory {
  readonly config: FullConfig;
  private readonly _manager: SharedBrowserManager;

  constructor(config: FullConfig, manager?: SharedBrowserManager) {
    this.config = config;
    this._manager = manager ?? new SharedBrowserManager();
  }

  get manager(): SharedBrowserManager {
    return this._manager;
  }

  async createContext(clientInfo: ClientInfo, abortSignal: AbortSignal, options: CreateContextOptions): Promise<BrowserContextFactoryResult> {
    testDebug('create browser context (shared browser)');

    // Try to connect to existing shared browser
    let browser = await this._manager.tryConnectExisting();
    let isNewBrowser = false;

    if (!browser) {
      // No existing browser, launch a new one
      testDebug('shared browser: no existing browser, launching new one');
      const launchOptions = {
        ...this.config.browser.launchOptions,
        ...(options.forceHeadless !== undefined ? { headless: options.forceHeadless === 'headless' } : {}),
      };

      const result = await this._manager.launchAndRegister(
        this.config.browser.browserName,
        launchOptions
      ).catch(error => {
        if (error.message.includes('Executable doesn\'t exist'))
          throw new Error(`Browser specified in your config is not installed. Either install it (likely) or change the config.`);
        throw error;
      });

      browser = result.browser;
      isNewBrowser = true;
    } else {
      // Connected to existing browser, increment reference count
      testDebug('shared browser: connected to existing browser, incrementing ref count');
      await this._manager.incrementRefCount();
    }

    // Create a new isolated BrowserContext
    const contextOptions = await this._browserContextOptionsFromConfig(clientInfo);
    const browserContext = await browser.newContext(contextOptions);

    // Add init scripts
    await this._addInitScript(browserContext);

    testDebug('shared browser: created browser context');

    // Return context with close handler
    return {
      browserContext,
      close: async () => {
        testDebug('shared browser: closing browser context');

        // Close the browser context
        await browserContext.close().catch(logUnhandledError);

        // Decrement reference count
        const shouldCloseBrowser = await this._manager.decrementRefCount();

        // If this was the last reference, close the browser
        if (shouldCloseBrowser) {
          testDebug('shared browser: last reference, closing browser');
          await browser.close().catch(logUnhandledError);
        }
      }
    };
  }

  private async _addInitScript(browserContext: playwright.BrowserContext): Promise<void> {
    for (const scriptPath of this.config.browser.initScript ?? [])
      await browserContext.addInitScript({ path: path.resolve(scriptPath) });
  }

  private async _browserContextOptionsFromConfig(clientInfo: ClientInfo): Promise<playwright.BrowserContextOptions> {
    const result: BrowserContextOptions = { ...this.config.browser.contextOptions };

    // Note: saveVideo is validated to not be used with shared browser context in config.ts
    // so we don't need to handle it here

    return result;
  }
}
