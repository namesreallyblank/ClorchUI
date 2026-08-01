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

import debug from 'debug';
import { Context } from './context';
import { Response } from './response';
import { SessionLog } from './sessionLog';
import type { ContextConfig } from './context';
import type * as playwright from '../../..';
import type { Tool } from './tool';
import type * as mcpServer from '../utils/mcp/server';
import type { ClientInfo, ServerBackend } from '../utils/mcp/server';

export class BrowserBackend implements ServerBackend {
  private _tools: Tool[];
  private _context: Context | undefined;
  private _sessionLog: SessionLog | undefined;
  private _config: ContextConfig;
  private _reportedDisconnect = false;
  readonly browserContext: playwright.BrowserContext;

  constructor(config: ContextConfig, browserContext: playwright.BrowserContext, tools: Tool[]) {
    this._config = config;
    this._tools = tools;
    this.browserContext = browserContext;
  }

  async initialize(clientInfo: ClientInfo): Promise<void> {
    this._sessionLog = this._config.saveSession ? await SessionLog.create(this._config, clientInfo.cwd) : undefined;
    this._context = new Context(this.browserContext, {
      config: this._config,
      sessionLog: this._sessionLog,
      cwd: clientInfo.cwd,
    });
  }

  async dispose() {
    await this._context?.dispose().catch(e => debug('pw:tools:error')(e));
  }

  async callTool(name: string, rawArguments: mcpServer.CallToolRequest['params']['arguments'] & { _meta?: Record<string, any> } = {}): Promise<mcpServer.CallToolResult> {
    const json = !!rawArguments._meta?.json;
    const formatError = (message: string): mcpServer.CallToolResult => ({
      content: [{ type: 'text' as const, text: json ? JSON.stringify({ isError: true, error: message }, null, 2) : `### Error\n${message}` }],
      isError: true,
    });
    const tool = this._tools.find(tool => tool.schema.name === name)!;
    if (!tool)
      return formatError(`Tool "${name}" not found`);
    // The browser this context is bound to is a shared, potentially multi-sibling
    // resource (see class docs on Context re: shared browser-server sockets). This
    // process never rebuilds it, so once the underlying connection dies, `isConnected()`
    // flips false permanently and stays false for the life of this process -- there is
    // no per-tool-call flakiness to worry about. Check it up front so a dead session
    // fails fast with one clear, stable, actionable error instead of hammering a dead
    // connection and re-deriving the same failure every call.
    const browser = this.browserContext.browser();
    if (browser && !browser.isConnected())
      return this._disconnectedError(json);
    // eslint-disable-next-line no-restricted-syntax
    const parsedArguments = tool.schema.inputSchema.parse(rawArguments) as any;
    const cwd = rawArguments._meta?.cwd;
    const raw = !!rawArguments._meta?.raw;
    const context = this._context!;
    const response = new Response(context, name, parsedArguments, { relativeTo: cwd, raw, json });
    context.setRunningTool(name);
    let responseObject: mcpServer.CallToolResult;
    try {
      await tool.handle(context, parsedArguments, response);
      for (const reason of context.drainPendingUnhandledRejections())
        response.addError(formatRejectionReason(reason));
      responseObject = await response.serialize();
      this._sessionLog?.logResponse(name, parsedArguments, responseObject);
    } catch (error: any) {
      // The tool call may be what surfaces the disconnect for the first time (a call
      // in flight when the connection dropped). Re-check rather than trusting the raw
      // error shape/message -- `browser.isConnected()` is the SDK's own authoritative
      // signal and is stable across error class/module boundaries, unlike matching on
      // error text or instanceof across the client/server error-class split.
      if (browser && !browser.isConnected())
        return this._disconnectedError(json);
      const messages = [String(error), ...context.drainPendingUnhandledRejections().map(formatRejectionReason)];
      return formatError(messages.join('\n\n'));
    } finally {
      context.setRunningTool(undefined);
    }
    return responseObject;
  }

  // Deliberately NOT a reconnect/recovery attempt: this process's browser/context is a
  // one-shot construction (see initialize()) and, when a browser server is shared across
  // sibling sessions via a socket endpoint, may be a single shared context -- rebuilding
  // or touching it here risks tearing down a live sibling's session. Recovering for real
  // requires re-acquiring a profile slot and restarting this process with a fresh
  // connection, which is outside what a single tool call can safely do. This only reports
  // the dead state clearly and stably so the caller can act (e.g. restart the session).
  private _disconnectedError(json: boolean): mcpServer.CallToolResult {
    if (!this._reportedDisconnect) {
      this._reportedDisconnect = true;
      debug('pw:tools:error')('browser connection lost; failing fast on all further tool calls until this process is restarted');
    }
    const message = 'Browser connection lost: the browser this session was bound to is no longer reachable. '
      + 'This process does not attempt to reconnect automatically, because the browser may be shared with '
      + 'other sessions and a blind rebuild could disrupt them. Restart this MCP session to reconnect '
      + '(a fresh process will re-acquire a browser through the normal startup path).';
    return {
      content: [{
        type: 'text' as const,
        text: json
          ? JSON.stringify({ isError: true, errorCode: 'BROWSER_DISCONNECTED', error: message }, null, 2)
          : `### Error: BROWSER_DISCONNECTED\n${message}`,
      }],
      isError: true,
    };
  }
}

function formatRejectionReason(reason: unknown): string {
  if (reason instanceof Error)
    return reason.stack ?? reason.message;
  return String(reason);
}
