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

/**
 * The in-page Clorch HUD client.
 *
 * This function is serialized and injected into every page (and after every
 * navigation) via `browserContext.addInitScript(hudClientScript, { port })`.
 * It MUST be fully self-contained (no imports, no closures over module scope)
 * because it executes inside the browser, not the Node process.
 *
 * The single serializable argument carries the ephemeral WebSocket port that
 * the MCP-process HUD server is listening on (127.0.0.1).
 */
export function hudClientScript(arg: { port: number }) {
  // Guard against double-injection (addInitScript + manual evaluate fallback).
  const w = window as any;
  if (w.__clorchHudInstalled)
    return;
  w.__clorchHudInstalled = true;

  const PORT = arg.port;
  const NS = 'clorch-hud-';
  const Z = 2147483646;

  // ---- Design tokens (Clorch dashboard: lime on near-black, JetBrains Mono) ----
  const T = {
    overlayBg: '#0E1215',
    cardBg: '#1A1F25',
    pageDark: '#07090A',
    inputBg: '#0A0E14',
    accent: '#C4F000',
    limeBorder: 'rgba(196,240,0,0.18)',
    limeFill: 'rgba(196,240,0,0.08)',
    limeDim: '#8FB000',
    ink: '#E6EAEE',
    muted: '#7A848F',
    dim: '#4B555F',
    amber: '#F5B942',
    rose: '#F06060',
    mono: `'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace`,
  };

  // ---- WebSocket connection with reconnect/backoff ----
  let ws: WebSocket | null = null;
  let connected = false;
  let backoff = 500;
  let dotEl: HTMLElement | null = null;

  function setConnected(state: boolean) {
    connected = state;
    if (dotEl) {
      dotEl.style.background = state ? T.accent : T.dim;
      dotEl.style.boxShadow = state ? '0 0 0 3px rgba(196,240,0,0.15)' : 'none';
    }
  }

  function connect() {
    try {
      ws = new WebSocket('wss://127.0.0.1:' + PORT);
    } catch (err) {
      // Construction can throw on malformed URL / blocked schemes. Log and retry.
      // eslint-disable-next-line no-console
      console.warn('[clorch-hud] WebSocket construction failed:', err);
      scheduleReconnect();
      return;
    }
    ws.onopen = () => {
      setConnected(true);
      backoff = 500;
    };
    ws.onclose = () => {
      setConnected(false);
      scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose will follow and trigger reconnect; just reflect state.
      setConnected(false);
    };
  }

  function scheduleReconnect() {
    const delay = backoff;
    backoff = Math.min(backoff * 2, 10000);
    setTimeout(connect, delay);
  }

  function sendMessage(payload: any) {
    if (!ws || ws.readyState !== WebSocket.OPEN)
      return false;
    try {
      ws.send(JSON.stringify(payload));
      return true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[clorch-hud] send failed:', err);
      return false;
    }
  }

  // ---- Robust dependency-free CSS selector generator ----
  function cssPath(el: Element | null): string {
    if (!el || el.nodeType !== 1)
      return '';
    if ((el as HTMLElement).id)
      return '#' + cssEscape((el as HTMLElement).id);
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      let selector = node.nodeName.toLowerCase();
      const id = (node as HTMLElement).id;
      if (id) {
        selector = '#' + cssEscape(id);
        parts.unshift(selector);
        break;
      }
      // Add a meaningfully-narrowing class if available.
      const cls = stableClass(node);
      if (cls)
        selector += '.' + cssEscape(cls);
      // nth-of-type for disambiguation among same-tag siblings.
      const parent = node.parentElement;
      if (parent) {
        const sameTag = Array.prototype.filter.call(
            parent.children,
            (c: Element) => c.nodeName === node!.nodeName);
        if (sameTag.length > 1) {
          const idx = Array.prototype.indexOf.call(sameTag, node) + 1;
          selector += ':nth-of-type(' + idx + ')';
        }
      }
      parts.unshift(selector);
      node = parent;
    }
    return parts.join(' > ');
  }

  function stableClass(el: Element): string | null {
    const classList = (el as HTMLElement).classList;
    if (!classList || !classList.length)
      return null;
    for (let i = 0; i < classList.length; i++) {
      const c = classList[i];
      // Skip our own namespace and obviously dynamic/utility-ish hashed classes.
      if (c.indexOf(NS) === 0)
        continue;
      if (/^[a-zA-Z][\w-]*$/.test(c) && c.length <= 40)
        return c;
    }
    return null;
  }

  function cssEscape(s: string): string {
    if (window.CSS && (window.CSS as any).escape)
      return (window.CSS as any).escape(s);
    return s.replace(/([^a-zA-Z0-9_-])/g, '\\$1');
  }

  // ---- Picker state ----
  let picking = false;
  let hoverEl: Element | null = null;
  let selected: { selector: string; tag: string; text: string; el: Element } | null = null;

  const highlightBox = document.createElement('div');
  highlightBox.className = NS + 'highlight';
  Object.assign(highlightBox.style, {
    position: 'fixed',
    pointerEvents: 'none',
    zIndex: String(Z),
    border: '2px solid ' + T.accent,
    background: 'rgba(196,240,0,0.06)',
    boxSizing: 'border-box',
    display: 'none',
    transition: 'all 40ms linear',
  } as CSSStyleDeclaration);

  const hoverLabel = document.createElement('div');
  hoverLabel.className = NS + 'hover-label';
  Object.assign(hoverLabel.style, {
    position: 'fixed',
    zIndex: String(Z),
    pointerEvents: 'none',
    background: T.pageDark,
    color: T.accent,
    border: '1px solid ' + T.limeBorder,
    borderRadius: '6px',
    font: '11px ' + T.mono,
    padding: '3px 7px',
    maxWidth: '480px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    display: 'none',
  } as CSSStyleDeclaration);

  function onMouseMove(e: MouseEvent) {
    if (!picking)
      return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || isOwnNode(el)) {
      highlightBox.style.display = 'none';
      hoverLabel.style.display = 'none';
      hoverEl = null;
      return;
    }
    hoverEl = el;
    const r = el.getBoundingClientRect();
    Object.assign(highlightBox.style, {
      display: 'block',
      left: r.left + 'px',
      top: r.top + 'px',
      width: r.width + 'px',
      height: r.height + 'px',
    } as CSSStyleDeclaration);
    const label = el.nodeName.toLowerCase() + '  ' + cssPath(el);
    hoverLabel.textContent = label;
    hoverLabel.style.display = 'block';
    const ly = r.top - 24 < 0 ? r.bottom + 4 : r.top - 24;
    hoverLabel.style.left = Math.max(0, r.left) + 'px';
    hoverLabel.style.top = ly + 'px';
  }

  function onClickCapture(e: MouseEvent) {
    if (!picking)
      return;
    const el = hoverEl || document.elementFromPoint(e.clientX, e.clientY);
    if (!el || isOwnNode(el))
      return;
    e.preventDefault();
    e.stopPropagation();
    selected = {
      selector: cssPath(el),
      tag: el.nodeName.toLowerCase(),
      text: ((el as HTMLElement).innerText || el.textContent || '').trim().slice(0, 200),
      el,
    };
    stopPicking();
    openPanel();
  }

  function isOwnNode(el: Element | null): boolean {
    let n: Node | null = el;
    while (n) {
      if (n instanceof Element && typeof n.className === 'string' && n.className.indexOf(NS) === 0)
        return true;
      n = (n as Node).parentNode;
    }
    return false;
  }

  function startPicking() {
    picking = true;
    document.documentElement.style.cursor = 'crosshair';
    highlightBox.style.display = 'none';
    hoverLabel.style.display = 'none';
  }

  function stopPicking() {
    picking = false;
    document.documentElement.style.cursor = '';
    highlightBox.style.display = 'none';
    hoverLabel.style.display = 'none';
    hoverEl = null;
  }

  // ---- The Clorch-styled panel ----
  let panel: HTMLElement | null = null;
  let inputEl: HTMLInputElement | null = null;

  function buildPanel() {
    const root = document.createElement('div');
    root.className = NS + 'panel';
    Object.assign(root.style, {
      position: 'fixed',
      right: '20px',
      bottom: '20px',
      zIndex: String(Z),
      width: '420px',
      background: T.overlayBg,
      borderRadius: '12px',
      boxShadow: '0 30px 80px -30px rgba(0,0,0,0.8), 0 0 0 1px rgba(196,240,0,0.08)',
      padding: '14px 16px',
      font: '12.5px ' + T.mono,
      color: T.ink,
    } as CSSStyleDeclaration);

    // Header row: diamond mark + eyebrow title + connection dot.
    const header = document.createElement('div');
    Object.assign(header.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      marginBottom: '10px',
    } as CSSStyleDeclaration);

    const markWrap = document.createElement('span');
    markWrap.className = NS + 'mark';
    markWrap.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M8 1.2 L14.8 8 L8 14.8 L1.2 8 Z" fill="#C4F000"/></svg>';
    markWrap.style.lineHeight = '0';

    const title = document.createElement('span');
    title.className = NS + 'title';
    title.textContent = 'CLORCH HUD';
    Object.assign(title.style, {
      font: '10.5px ' + T.mono,
      textTransform: 'uppercase',
      letterSpacing: '.14em',
      color: T.muted,
      flex: '1',
    } as CSSStyleDeclaration);

    dotEl = document.createElement('span');
    dotEl.className = NS + 'dot';
    Object.assign(dotEl.style, {
      width: '8px',
      height: '8px',
      borderRadius: '9999px',
      background: connected ? T.accent : T.dim,
      boxShadow: connected ? '0 0 0 3px rgba(196,240,0,0.15)' : 'none',
      display: 'inline-block',
    } as CSSStyleDeclaration);

    header.appendChild(markWrap);
    header.appendChild(title);
    header.appendChild(dotEl);

    // Selected element readout.
    const readout = document.createElement('div');
    readout.className = NS + 'readout';
    Object.assign(readout.style, {
      background: T.cardBg,
      border: '1px solid ' + T.limeBorder,
      borderRadius: '6px',
      padding: '7px 10px',
      marginBottom: '10px',
      font: '11px ' + T.mono,
      color: T.muted,
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    } as CSSStyleDeclaration);
    readout.textContent = selectedReadout();

    // Message input.
    const input = document.createElement('input');
    input.className = NS + 'input';
    input.type = 'text';
    input.placeholder = 'Type a message and press Enter…';
    Object.assign(input.style, {
      width: '100%',
      boxSizing: 'border-box',
      background: T.inputBg,
      border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: '6px',
      padding: '7px 10px',
      font: '12.5px ' + T.mono,
      color: T.ink,
      outline: 'none',
      marginBottom: '10px',
    } as CSSStyleDeclaration);
    input.addEventListener('focus', () => {
      input.style.borderColor = 'rgba(196,240,0,0.6)';
    });
    input.addEventListener('blur', () => {
      input.style.borderColor = 'rgba(255,255,255,0.08)';
    });
    inputEl = input;

    // Footer row: hint + send button.
    const footer = document.createElement('div');
    Object.assign(footer.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '10px',
    } as CSSStyleDeclaration);

    const confirm = document.createElement('span');
    confirm.className = NS + 'confirm';
    Object.assign(confirm.style, {
      flex: '1',
      font: '10.5px ' + T.mono,
      letterSpacing: '.08em',
      color: T.dim,
    } as CSSStyleDeclaration);
    confirm.textContent = 'Ctrl/Cmd+Shift+K to re-pick · Esc to close';

    const sendBtn = document.createElement('button');
    sendBtn.className = NS + 'send';
    sendBtn.textContent = 'Send ⏎';
    Object.assign(sendBtn.style, {
      background: 'rgba(196,240,0,0.1)',
      color: T.accent,
      border: '1px solid rgba(196,240,0,0.4)',
      borderRadius: '6px',
      padding: '6px 12px',
      font: '11px ' + T.mono,
      letterSpacing: '.08em',
      cursor: 'pointer',
    } as CSSStyleDeclaration);
    sendBtn.addEventListener('mouseenter', () => {
      sendBtn.style.background = 'rgba(196,240,0,0.18)';
    });
    sendBtn.addEventListener('mouseleave', () => {
      sendBtn.style.background = 'rgba(196,240,0,0.1)';
    });
    sendBtn.addEventListener('click', () => doSend(confirm));

    footer.appendChild(confirm);
    footer.appendChild(sendBtn);

    root.appendChild(header);
    root.appendChild(readout);
    root.appendChild(input);
    root.appendChild(footer);

    // Keyboard isolation: stop page hotkeys while typing in the HUD.
    const stop = (e: Event) => e.stopPropagation();
    root.addEventListener('keydown', e => {
      stop(e);
      const ke = e as KeyboardEvent;
      if (ke.key === 'Enter') {
        ke.preventDefault();
        doSend(confirm);
      } else if (ke.key === 'Escape') {
        ke.preventDefault();
        closePanel();
      }
    }, true);
    root.addEventListener('keypress', stop, true);
    root.addEventListener('keyup', stop, true);

    return { root, readout, confirm };
  }

  function selectedReadout(): string {
    if (!selected || !selected.selector)
      return 'No element selected — message will be sent without a target.';
    const t = selected.text ? '  “' + selected.text.slice(0, 48) + (selected.text.length > 48 ? '…' : '') + '”' : '';
    return selected.tag + '  ' + selected.selector + t;
  }

  let currentReadout: HTMLElement | null = null;

  function openPanel() {
    closePanel();
    const built = buildPanel();
    panel = built.root;
    currentReadout = built.readout;
    document.body.appendChild(panel);
    // Defer focus so the click that opened us doesn't steal it back.
    setTimeout(() => inputEl && inputEl.focus(), 0);
  }

  function closePanel() {
    if (panel && panel.parentNode)
      panel.parentNode.removeChild(panel);
    panel = null;
    inputEl = null;
    currentReadout = null;
  }

  function doSend(confirmEl: HTMLElement) {
    if (!inputEl)
      return;
    const message = inputEl.value.trim();
    if (!message)
      return;
    const rect = selected ? selected.el.getBoundingClientRect() : null;
    const payload = {
      type: 'hud_message',
      selector: selected ? selected.selector : '',
      tag: selected ? selected.tag : '',
      text: selected ? selected.text : '',
      message,
      url: location.href,
      wantsShot: true,
      bbox: rect ? {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        dpr: window.devicePixelRatio || 1,
      } : null,
    };
    const ok = sendMessage(payload);
    if (ok) {
      inputEl.value = '';
      confirmEl.textContent = 'sent ✓';
      confirmEl.style.color = T.accent;
      setTimeout(() => {
        if (confirmEl.isConnected) {
          confirmEl.textContent = 'Ctrl/Cmd+Shift+K to re-pick · Esc to close';
          confirmEl.style.color = T.dim;
        }
      }, 1600);
    } else {
      confirmEl.textContent = 'not connected — retrying…';
      confirmEl.style.color = T.rose;
    }
  }

  // ---- Global hotkey + esc handling ----
  function onKeyDown(e: KeyboardEvent) {
    const mod = (e.ctrlKey || e.metaKey) && e.shiftKey;
    if (mod && (e.key === 'K' || e.key === 'k')) {
      e.preventDefault();
      e.stopPropagation();
      if (picking) {
        stopPicking();
      } else {
        // If a panel is already open with no selection, re-arm picking.
        startPicking();
      }
      return;
    }
    if (e.key === 'Escape') {
      if (picking) {
        e.preventDefault();
        stopPicking();
      } else if (panel) {
        // Esc inside the panel is handled by the panel's own listener; this
        // covers Esc when focus is outside the input.
        closePanel();
      }
    }
  }

  // ---- Bootstrap ----
  function install() {
    if (!document.body) {
      // Defer until body exists (init scripts may run before DOM ready).
      window.addEventListener('DOMContentLoaded', install, { once: true });
      return;
    }
    document.body.appendChild(highlightBox);
    document.body.appendChild(hoverLabel);
    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('click', onClickCapture, true);
    document.addEventListener('keydown', onKeyDown, true);
    connect();
  }

  install();

  // Expose a tiny programmatic API for the activation tool / debugging.
  w.__clorchHud = {
    openPicker: startPicking,
    openPanel,
    closePanel,
    isConnected: () => connected,
  };
}

/**
 * Stringified body of {@link hudClientScript} suitable for `page.evaluate`
 * with an argument, or for embedding. We pass the function itself to
 * addInitScript; this string form is used by the activation tool's
 * immediate-injection fallback path.
 */
export const hudClientSource = hudClientScript.toString();
