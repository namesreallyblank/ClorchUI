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

import crypto from 'crypto';
import fs from 'fs';
import https from 'https';
import os from 'os';
import path from 'path';

import debug from 'debug';
import { WebSocketServer } from 'ws';
import { ManualPromise } from '@isomorphic/manualPromise';
import { generateSelfSignedCertificate } from '@utils/crypto';

import type { WebSocket } from 'ws';
import type * as playwrightTypes from '../../..';

const log = debug('pw:mcp:hud');

export type HudMessage = {
  selector: string;
  message: string;
  tag: string;
  text: string;
  url: string;
};

type HudBbox = { x: number; y: number; width: number; height: number; dpr: number };

type ReceivedHudMessage = HudMessage & {
  timestamp: string;
  screenshot?: string;
  bbox?: HudBbox | null;
  wantsShot?: boolean;
};

class HudServer {
  private _httpsServer: https.Server;
  private _wss: WebSocketServer;
  private _port = 0;
  private _sockets = new Set<WebSocket>();
  private _queue: ReceivedHudMessage[] = [];
  private _pending: ManualPromise<ReceivedHudMessage | null> | null = null;
  private _readyPromise: Promise<number>;
  private _projectRoot: string;
  // Bridge from Context.ensureHudInjected — used by _captureShot to resolve a
  // Page by URL when a HUD message arrives.
  private _browserContext: playwrightTypes.BrowserContext | null = null;

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
        // Fire-and-forget; _onHudMessage handles its own errors internally,
        // but log any unhandled rejection rather than letting it surface as
        // an unhandled promise rejection (silent-failure rule).
        this._onHudMessage(parsed).catch(err => {
          log('HUD onMessage unhandled error: %s', (err as Error).message);
        });
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

  private async _onHudMessage(parsed: any) {
    const bbox: HudBbox | null = parsed && parsed.bbox && typeof parsed.bbox === 'object' ? {
      x: Number(parsed.bbox.x) || 0,
      y: Number(parsed.bbox.y) || 0,
      width: Number(parsed.bbox.width) || 0,
      height: Number(parsed.bbox.height) || 0,
      dpr: Number(parsed.bbox.dpr) || 1,
    } : null;
    const received: ReceivedHudMessage = {
      selector: String(parsed.selector ?? ''),
      message: String(parsed.message ?? ''),
      tag: String(parsed.tag ?? ''),
      text: String(parsed.text ?? ''),
      url: String(parsed.url ?? ''),
      timestamp: new Date().toISOString(),
      wantsShot: parsed.wantsShot === true,
      bbox,
    };
    log('HUD message received: %j', { ...received, bbox: received.bbox ? '<bbox>' : null });

    // Capture screenshot BEFORE queue/append so the JSONL line carries the path.
    if (received.wantsShot) {
      const shotPath = await this._captureShot(received);
      if (shotPath)
        received.screenshot = shotPath;
    }

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

  /**
   * Register the active BrowserContext so _captureShot can resolve a Page by
   * URL. Called from Context.ensureHudInjected. The most recently registered
   * context wins — a fresh `claude` session always rebinds before injection.
   */
  registerBrowserContext(browserContext: playwrightTypes.BrowserContext): void {
    this._browserContext = browserContext;
  }

  /**
   * Pick the best Page for a HUD message URL. Strategy:
   *   1. Exact URL match.
   *   2. Same origin + pathname (querystring may have drifted).
   *   3. Single-page session → use the only page.
   *   4. Most recently active page (last in pages() list, Playwright convention).
   */
  private _findPageForUrl(url: string): playwrightTypes.Page | null {
    const ctx = this._browserContext;
    if (!ctx)
      return null;
    const pages = ctx.pages();
    if (!pages.length)
      return null;
    if (pages.length === 1)
      return pages[0];
    const exact = pages.find(p => p.url() === url);
    if (exact)
      return exact;
    try {
      const want = new URL(url);
      const sameOriginPath = pages.find(p => {
        try {
          const have = new URL(p.url());
          return have.origin === want.origin && have.pathname === want.pathname;
        } catch {
          return false;
        }
      });
      if (sameOriginPath)
        return sameOriginPath;
    } catch {
      // Malformed url string — fall through to last-page fallback.
    }
    return pages[pages.length - 1];
  }

  /**
   * Capture a PNG of the picked element + 32px padding (viewport-clipped).
   *
   * Resolution order:
   *   1. page.locator(selector).boundingBox() (live, auto-scrolls into view)
   *   2. payload bbox from the client (viewport-coords at send time)
   *   3. full-page fallback (Decision 5 — blurry beats empty)
   *
   * Returns absolute path to the written PNG, or undefined on failure or when
   * disabled via CLORCHUI_HUD_SHOTS=off. Never throws — logs and returns.
   */
  private async _captureShot(received: ReceivedHudMessage): Promise<string | undefined> {
    if (process.env.CLORCHUI_HUD_SHOTS === 'off') {
      log('HUD shot skipped — CLORCHUI_HUD_SHOTS=off');
      return undefined;
    }
    const page = this._findPageForUrl(received.url);
    if (!page) {
      log('HUD shot skipped — no page registered for url=%s', received.url);
      return undefined;
    }

    const shotsDir = path.join(this._projectRoot, '.clorchui-hud-shots');
    const tsFile = received.timestamp.replace(/[:.]/g, '-');
    const hash6 = crypto.randomBytes(3).toString('hex');
    const outPath = path.join(shotsDir, `${tsFile}-${hash6}.png`);

    try {
      fs.mkdirSync(shotsDir, { recursive: true });
    } catch (err) {
      log('HUD shot mkdir failed: %s', (err as Error).message);
      return undefined;
    }

    // Determine viewport for clip clamping. viewportSize() can be null in
    // some edge cases (e.g. windowed mode); fall back to a sane default.
    const vp = page.viewportSize() || { width: 1280, height: 720 };

    // Try selector → bbox fallback → full-page fallback.
    let rect: { x: number; y: number; width: number; height: number } | null = null;
    if (received.selector) {
      try {
        const box = await page.locator(received.selector).first().boundingBox({ timeout: 1500 });
        if (box && box.width > 0 && box.height > 0)
          rect = box;
      } catch (err) {
        log('HUD shot locator boundingBox failed: %s', (err as Error).message);
      }
    }
    if (!rect && received.bbox && received.bbox.width > 0 && received.bbox.height > 0)
      rect = { x: received.bbox.x, y: received.bbox.y, width: received.bbox.width, height: received.bbox.height };

    // Hide the HUD overlay (picker highlight, hover label, panel, etc.) for the
    // duration of the screenshot so it doesn't appear in the captured PNG.
    // Uses visibility:hidden (not display:none) to preserve layout — page.screenshot
    // clip coords are resolved against the live viewport, so any reflow would crop
    // the wrong area. Hide/capture/restore is wrapped in try/finally so a capture
    // failure still restores the overlay.
    let hudHidden = false;
    try {
      hudHidden = await page.evaluate(() => {
        const w = window as any;
        if (!w.__clorchHud)
          return false;
        const NS = 'clorch-hud-';
        const nodes = document.querySelectorAll<HTMLElement>(`[class^="${NS}"], [class*=" ${NS}"]`);
        if (!nodes.length)
          return false;
        const stash: Array<[HTMLElement, string]> = [];
        nodes.forEach(n => {
          stash.push([n, n.style.visibility]);
          n.style.visibility = 'hidden';
        });
        w.__clorchHudShotStash = stash;
        return true;
      });
    } catch (err) {
      log('HUD shot hide-overlay failed: %s', (err as Error).message);
    }

    try {
      if (rect) {
        // Pad 32px on each side, clamp to viewport (never negative coords / never overshoot).
        const PAD = 32;
        const x = Math.max(0, Math.floor(rect.x - PAD));
        const y = Math.max(0, Math.floor(rect.y - PAD));
        const maxW = Math.max(0, vp.width - x);
        const maxH = Math.max(0, vp.height - y);
        const width = Math.min(maxW, Math.ceil(rect.width + PAD * 2 + Math.max(0, Math.floor(rect.x) - x)));
        const height = Math.min(maxH, Math.ceil(rect.height + PAD * 2 + Math.max(0, Math.floor(rect.y) - y)));
        if (width <= 0 || height <= 0) {
          log('HUD shot clip zero after clamp — full-page fallback');
          await page.screenshot({ path: outPath, type: 'png', fullPage: true });
        } else {
          await page.screenshot({ path: outPath, type: 'png', clip: { x, y, width, height } });
        }
      } else {
        log('HUD shot no rect resolved — full-page fallback (selector=%s)', received.selector);
        await page.screenshot({ path: outPath, type: 'png', fullPage: true });
      }
      log('HUD shot written: %s', outPath);
      return outPath;
    } catch (err) {
      log('HUD shot capture failed: %s', (err as Error).message);
      return undefined;
    } finally {
      if (hudHidden) {
        try {
          await page.evaluate(() => {
            const w = window as any;
            const stash: Array<[HTMLElement, string]> | undefined = w.__clorchHudShotStash;
            if (!stash)
              return;
            stash.forEach(([n, prev]) => {
              n.style.visibility = prev;
            });
            delete w.__clorchHudShotStash;
          });
        } catch (err) {
          log('HUD shot restore-overlay failed: %s', (err as Error).message);
        }
      }
    }
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
