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
import https from 'https';
import os from 'os';
import path from 'path';

import debug from 'debug';
import { WebSocketServer } from 'ws';
import { ManualPromise } from '@isomorphic/manualPromise';
import { generateSelfSignedCertificate } from '@utils/crypto';

import type { WebSocket } from 'ws';

const log = debug('pw:mcp:hud');

export type HudMessage = {
  selector: string;
  message: string;
  tag: string;
  text: string;
  url: string;
};

type ReceivedHudMessage = HudMessage & { timestamp: string };

class HudServer {
  private _httpsServer: https.Server;
  private _wss: WebSocketServer;
  private _port = 0;
  private _sockets = new Set<WebSocket>();
  private _queue: ReceivedHudMessage[] = [];
  private _pending: ManualPromise<ReceivedHudMessage | null> | null = null;
  private _readyPromise: Promise<number>;
  private _projectRoot: string;

  constructor(projectRoot: string) {
    this._projectRoot = projectRoot;
    // Serve the HUD ws over TLS (wss://). An insecure ws:// from an HTTPS
    // top-level origin is blocked by Chromium as mixed active content (the
    // handshake silently stalls). A self-signed cert for loopback fixes this;
    // the browser side accepts it via contextOptions.ignoreHTTPSErrors.
    const { cert, key } = generateSelfSignedCertificate();
    this._httpsServer = https.createServer({ cert, key });
    // Ephemeral port on loopback only.
    this._wss = new WebSocketServer({ server: this._httpsServer });
    this._httpsServer.listen(0, '127.0.0.1');

    this._readyPromise = new Promise<number>((resolve, reject) => {
      this._httpsServer.once('listening', () => {
        const address = this._httpsServer.address();
        if (address && typeof address === 'object') {
          this._port = address.port;
          log('HUD WebSocket server listening on wss://127.0.0.1:%d', this._port);
          resolve(this._port);
        } else {
          reject(new Error('HUD WebSocket server failed to obtain a port'));
        }
      });
      this._httpsServer.once('error', err => {
        log('HUD WebSocket server error during startup: %s', (err as Error).message);
        reject(err);
      });
    });

    this._wss.on('connection', socket => {
      this._sockets.add(socket);
      log('HUD client connected (total=%d)', this._sockets.size);

      socket.on('message', raw => {
        let parsed: any;
        try {
          parsed = JSON.parse(raw.toString());
        } catch (err) {
          // Never swallow silently (silent-failure rule).
          log('HUD message parse error: %s', (err as Error).message);
          return;
        }
        if (!parsed || parsed.type !== 'hud_message') {
          log('HUD ignoring non-hud_message frame: %j', parsed);
          return;
        }
        this._onHudMessage(parsed);
      });

      socket.on('error', err => {
        log('HUD socket error: %s', (err as Error).message);
      });

      socket.on('close', () => {
        this._sockets.delete(socket);
        log('HUD client disconnected (total=%d)', this._sockets.size);
      });
    });

    this._wss.on('error', err => {
      log('HUD WebSocket server error: %s', (err as Error).message);
    });
  }

  private _onHudMessage(parsed: any) {
    const received: ReceivedHudMessage = {
      selector: String(parsed.selector ?? ''),
      message: String(parsed.message ?? ''),
      tag: String(parsed.tag ?? ''),
      text: String(parsed.text ?? ''),
      url: String(parsed.url ?? ''),
      timestamp: new Date().toISOString(),
    };
    log('HUD message received: %j', received);

    // Resolve a waiting long-poll immediately; otherwise queue it.
    if (this._pending && !this._pending.isDone()) {
      const pending = this._pending;
      this._pending = null;
      pending.resolve(received);
    } else {
      this._queue.push(received);
    }

    // Always append to the durable workspace queue so prompts/watcher surface
    // it even if nobody is currently long-polling.
    this._appendQueue(received);
  }

  private _appendQueue(received: ReceivedHudMessage) {
    try {
      const target = path.join(this._projectRoot, '.clorchui-hud-queue.jsonl');
      // Append-only JSONL: one JSON object per line. appendFileSync creates the
      // file if missing and is atomic enough for single-line appends.
      fs.appendFileSync(target, JSON.stringify(received) + '\n', 'utf-8');
      log('HUD message appended to queue: %s', target);
    } catch (err) {
      // Log, never crash the socket handler.
      log('HUD queue append failed: %s', (err as Error).message);
    }
  }

  async ready(): Promise<number> {
    return this._readyPromise;
  }

  get port(): number {
    return this._port;
  }

  /**
   * Drain any messages already queued (received between watch calls), then
   * if none, wait up to timeoutMs for the next message. Resolves to null on
   * timeout so the caller can re-poll without hanging.
   */
  async waitForMessage(timeoutMs: number): Promise<ReceivedHudMessage | null> {
    if (this._queue.length)
      return this._queue.shift()!;

    // Single in-flight waiter; a new waiter replaces a stale one.
    const pending = new ManualPromise<ReceivedHudMessage | null>();
    this._pending = pending;

    const timer = setTimeout(() => {
      if (!pending.isDone()) {
        if (this._pending === pending)
          this._pending = null;
        pending.resolve(null);
      }
    }, timeoutMs);

    const result = await pending;
    clearTimeout(timer);
    return result;
  }

  /** Return and clear all currently-queued messages. */
  drainQueued(): ReceivedHudMessage[] {
    const drained = this._queue.slice();
    this._queue.length = 0;
    return drained;
  }
}

// Module-scope lazy singleton — the MCP process is long-lived stdio, so this
// persists across tool calls.
let _server: HudServer | null = null;
let _startPromise: Promise<HudServer> | null = null;

function resolveProjectRoot(cwd?: string): string {
  const root = cwd || process.cwd() || os.tmpdir();
  return root;
}

/**
 * Idempotently start (or return) the singleton HUD server. The first caller's
 * cwd determines the fallback-file project root.
 */
export async function ensureHudServer(cwd?: string): Promise<HudServer> {
  if (_server)
    return _server;
  if (_startPromise)
    return _startPromise;
  _startPromise = (async () => {
    const server = new HudServer(resolveProjectRoot(cwd));
    await server.ready();
    _server = server;
    return server;
  })();
  return _startPromise;
}

/** Synchronous accessor — returns null if the server has not started yet. */
export function getHudServer(): HudServer | null {
  return _server;
}

export type { HudServer, ReceivedHudMessage };
