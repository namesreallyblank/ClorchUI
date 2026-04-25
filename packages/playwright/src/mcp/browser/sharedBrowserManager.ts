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
import net from 'net';
import os from 'os';
import path from 'path';

import * as playwright from 'playwright-core';
import { logUnhandledError, testDebug } from '../log';

export interface SharedBrowserState {
  pid: number;
  cdpEndpoint: string;
  startTime: number;
  refCount: number;
  lastHeartbeat: number;
  port: number;
}

export class SharedBrowserManager {
  private readonly _pidFilePath: string;
  private readonly _lockFilePath: string;
  private _browser: playwright.Browser | undefined;
  private _cdpEndpoint: string | undefined;
  private _heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  constructor(pidFilePath?: string) {
    this._pidFilePath = pidFilePath ?? path.join(os.homedir(), '.claude', 'mcp-chrome-shared.json');
    this._lockFilePath = this._pidFilePath + '.lock';
  }

  async tryConnectExisting(): Promise<playwright.Browser | null> {
    try {
      const state = await this._readPidFile();
      if (!state)
        return null;

      const isValid = await this._validatePidFile(state);
      if (!isValid) {
        await this._removePidFile();
        return null;
      }

      testDebug('shared browser: connecting to existing browser', state.cdpEndpoint);
      const browser = await playwright.chromium.connectOverCDP(state.cdpEndpoint, {
        timeout: 10000
      }).catch((error) => {
        testDebug('shared browser: failed to connect to existing browser', error.message);
        return null;
      });

      if (browser) {
        this._browser = browser;
        this._cdpEndpoint = state.cdpEndpoint;
        testDebug('shared browser: connected to existing browser');
      }

      return browser;
    } catch (error: any) {
      logUnhandledError(error);
      return null;
    }
  }

  async launchAndRegister(browserName: string, launchOptions: any): Promise<{ browser: playwright.Browser; cdpEndpoint: string }> {
    const lockHandle = await this._acquireLock();
    try {
      const existingBrowser = await this.tryConnectExisting();
      if (existingBrowser) {
        testDebug('shared browser: another instance launched while acquiring lock');
        return { browser: existingBrowser, cdpEndpoint: this._cdpEndpoint! };
      }

      testDebug('shared browser: launching new browser');
      const browserType = playwright[browserName as 'chromium' | 'firefox' | 'webkit'];

      // Pre-allocate a CDP port for Chromium browsers
      const cdpPort = browserName === 'chromium' ? await this._findFreePort() : undefined;

      const browser = await browserType.launch({
        ...launchOptions,
        ...(cdpPort !== undefined ? { cdpPort } : {}),
        handleSIGINT: false,
        handleSIGTERM: false,
      });

      // Construct the CDP endpoint URL from the allocated port
      if (!cdpPort)
        throw new Error('Browser launched without CDP port');

      const cdpEndpoint = `ws://127.0.0.1:${cdpPort}`;
      const port = cdpPort;

      const state: SharedBrowserState = {
        pid: process.pid,
        cdpEndpoint,
        startTime: Date.now(),
        refCount: 1,
        lastHeartbeat: Date.now(),
        port,
      };

      await this._writePidFile(state);

      this._browser = browser;
      this._cdpEndpoint = cdpEndpoint;

      this._startHeartbeat();

      testDebug('shared browser: registered new browser', cdpEndpoint);
      return { browser, cdpEndpoint };
    } finally {
      await this._releaseLock(lockHandle);
    }
  }

  async incrementRefCount(): Promise<void> {
    const lockHandle = await this._acquireLock();
    try {
      const state = await this._readPidFile();
      if (!state)
        throw new Error('No shared browser state found');

      state.refCount++;
      state.lastHeartbeat = Date.now();
      await this._writePidFile(state);

      testDebug('shared browser: incremented ref count to', state.refCount);
    } finally {
      await this._releaseLock(lockHandle);
    }
  }

  async decrementRefCount(): Promise<boolean> {
    const lockHandle = await this._acquireLock();
    try {
      const state = await this._readPidFile();
      if (!state)
        return true;

      state.refCount = Math.max(0, state.refCount - 1);
      state.lastHeartbeat = Date.now();

      if (state.refCount === 0) {
        await this._removePidFile();
        testDebug('shared browser: ref count reached 0, removed PID file');
        return true;
      }

      await this._writePidFile(state);
      testDebug('shared browser: decremented ref count to', state.refCount);
      return false;
    } finally {
      await this._releaseLock(lockHandle);
    }
  }

  async cleanup(): Promise<void> {
    if (this._heartbeatInterval) {
      clearInterval(this._heartbeatInterval);
      this._heartbeatInterval = null;
    }

    try {
      const shouldClose = await this.decrementRefCount();

      if (shouldClose && this._browser) {
        testDebug('shared browser: closing browser');
        await this._browser.close().catch(logUnhandledError);
        this._browser = undefined;
        this._cdpEndpoint = undefined;
      }
    } catch (error: any) {
      logUnhandledError(error);
    }
  }

  private async _validatePidFile(state: SharedBrowserState): Promise<boolean> {
    const now = Date.now();
    const staleThreshold = 5 * 60 * 1000;

    if (now - state.lastHeartbeat > staleThreshold) {
      testDebug('shared browser: PID file is stale (no heartbeat)');
      return false;
    }

    if (!this._isProcessAlive(state.pid)) {
      testDebug('shared browser: process is not alive');
      return false;
    }

    try {
      await playwright.chromium.connectOverCDP(state.cdpEndpoint, {
        timeout: 3000
      }).then(browser => browser.close());
      return true;
    } catch {
      testDebug('shared browser: CDP endpoint unreachable');
      return false;
    }
  }

  private _isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error: any) {
      return error.code === 'EPERM';
    }
  }

  private async _readPidFile(): Promise<SharedBrowserState | null> {
    try {
      const content = await fs.promises.readFile(this._pidFilePath, 'utf8');
      return JSON.parse(content) as SharedBrowserState;
    } catch (error: any) {
      if (error.code === 'ENOENT')
        return null;

      testDebug('shared browser: failed to read PID file', error.message);
      try {
        await this._removePidFile();
      } catch {
      }
      return null;
    }
  }

  private async _writePidFile(state: SharedBrowserState): Promise<void> {
    const tmpPath = this._pidFilePath + '.tmp';
    const content = JSON.stringify(state, null, 2);

    await fs.promises.mkdir(path.dirname(this._pidFilePath), { recursive: true });
    await fs.promises.writeFile(tmpPath, content, 'utf8');
    await fs.promises.rename(tmpPath, this._pidFilePath);
  }

  private async _removePidFile(): Promise<void> {
    try {
      await fs.promises.unlink(this._pidFilePath);
    } catch (error: any) {
      if (error.code !== 'ENOENT')
        logUnhandledError(error);
    }
  }

  private async _acquireLock(): Promise<fs.promises.FileHandle> {
    const maxRetries = 10;
    const retryDelay = 100;
    const staleLockThreshold = 30000;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const handle = await fs.promises.open(this._lockFilePath, 'wx');
        return handle;
      } catch (error: any) {
        if (error.code !== 'EEXIST')
          throw error;

        try {
          const stats = await fs.promises.stat(this._lockFilePath);
          const lockAge = Date.now() - stats.mtimeMs;

          if (lockAge > staleLockThreshold) {
            testDebug('shared browser: removing stale lock file');
            await fs.promises.unlink(this._lockFilePath).catch(() => {});
            continue;
          }
        } catch {
        }

        await new Promise(resolve => setTimeout(resolve, retryDelay * (attempt + 1)));
      }
    }

    throw new Error('Failed to acquire lock after multiple retries');
  }

  private async _releaseLock(handle: fs.promises.FileHandle): Promise<void> {
    try {
      await handle.close();
      await fs.promises.unlink(this._lockFilePath);
    } catch (error: any) {
      logUnhandledError(error);
    }
  }

  private _startHeartbeat(): void {
    if (this._heartbeatInterval)
      clearInterval(this._heartbeatInterval);

    this._heartbeatInterval = setInterval(() => {
      this._updateHeartbeat().catch(logUnhandledError);
    }, 60_000);
  }

  private async _updateHeartbeat(): Promise<void> {
    const lockHandle = await this._acquireLock();
    try {
      const state = await this._readPidFile();
      if (!state)
        return;

      state.lastHeartbeat = Date.now();
      await this._writePidFile(state);
      testDebug('shared browser: heartbeat updated');
    } finally {
      await this._releaseLock(lockHandle);
    }
  }

  private _extractPortFromEndpoint(endpoint: string): number {
    const match = endpoint.match(/:(\d+)\//);
    return match ? parseInt(match[1], 10) : 0;
  }

  private async _findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.listen(0, () => {
        const { port } = server.address() as net.AddressInfo;
        server.close(() => resolve(port));
      });
      server.on('error', reject);
    });
  }
}
