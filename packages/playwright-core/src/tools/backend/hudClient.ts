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

  // Light-theme overrides for the handful of tokens the HUD chrome actually
  // uses. Kept intentionally small — we are not re-skinning the whole token set.
  const LIGHT = {
    overlayBg: '#F4F6F4',
    cardBg: '#FFFFFF',
    inputBg: '#FFFFFF',
    accent: '#5E7A00',
    limeBorder: 'rgba(94,122,0,0.30)',
    ink: '#10140F',
    muted: '#5A6560',
    dim: '#9AA39C',
  };

  // ---- Persisted settings (module-scope-in-script + localStorage) ----
  // The panel is destroyed/rebuilt on every open, so all durable state lives
  // here and is re-applied inside buildPanel().
  const LS_SETTINGS = 'clorch-hud-settings';
  const LS_POS = 'clorch-hud-pos';
  const LS_SIZE = 'clorch-hud-size';
  const DEFAULT_WIDTH = 420;

  const SETTINGS_DEFAULTS = {
    attachShot: true,
    pad: 32,
    theme: 'dark' as 'dark' | 'light',
    defaultMode: 'element' as 'element' | 'region',
  };
  let settings = { ...SETTINGS_DEFAULTS };

  function loadSettings() {
    try {
      const raw = localStorage.getItem(LS_SETTINGS);
      if (raw) {
        const parsed = JSON.parse(raw);
        settings = {
          attachShot: parsed.attachShot !== false,
          pad: clampPad(Number(parsed.pad)),
          theme: parsed.theme === 'light' ? 'light' : 'dark',
          defaultMode: parsed.defaultMode === 'region' ? 'region' : 'element',
        };
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[clorch-hud] storage unavailable (loadSettings):', err);
      settings = { ...SETTINGS_DEFAULTS };
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(LS_SETTINGS, JSON.stringify(settings));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[clorch-hud] storage unavailable (saveSettings):', err);
    }
  }

  function clampPad(n: number): number {
    if (!isFinite(n) || n < 0)
      return SETTINGS_DEFAULTS.pad;
    return Math.min(200, Math.floor(n));
  }

  // Persisted panel geometry, read once at init (re-applied in buildPanel).
  let savedPos: { left: number; top: number } | null = null;
  let savedSize: { width: number; height: number } | null = null;

  function loadGeometry() {
    try {
      const p = localStorage.getItem(LS_POS);
      if (p) {
        const o = JSON.parse(p);
        if (typeof o.left === 'number' && typeof o.top === 'number')
          savedPos = { left: o.left, top: o.top };
      }
      const s = localStorage.getItem(LS_SIZE);
      if (s) {
        const o = JSON.parse(s);
        if (typeof o.width === 'number' && typeof o.height === 'number')
          savedSize = { width: o.width, height: o.height };
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[clorch-hud] storage unavailable (loadGeometry):', err);
      savedPos = null;
      savedSize = null;
    }
  }

  // Active theme token accessor — merges the light overrides over the base set.
  function tk(key: keyof typeof T): string {
    if (settings.theme === 'light' && key in LIGHT)
      return (LIGHT as any)[key];
    return (T as any)[key];
  }

  loadSettings();
  loadGeometry();

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

  // ---- Region-draw state ----
  // captureKind decides what doSend() ships: an element selector or a region bbox.
  let drawing = false;            // draw mode armed (waiting for first mousedown)
  let drawActive = false;         // a drag is currently in progress
  let drawStart: { x: number; y: number } | null = null;
  let drawnRect: { x: number; y: number; width: number; height: number } | null = null;
  let captureKind: 'element' | 'region' = 'element';

  const drawRect = document.createElement('div');
  drawRect.className = NS + 'draw-rect';
  Object.assign(drawRect.style, {
    position: 'fixed',
    pointerEvents: 'none',
    zIndex: String(Z - 1),
    border: '2px dashed ' + tk('accent'),
    background: 'rgba(196,240,0,0.08)',
    boxSizing: 'border-box',
    display: 'none',
  } as CSSStyleDeclaration);

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
    // Region-draw resizing takes precedence while a drag is in progress.
    if (drawActive && drawStart) {
      const r = normRect(drawStart.x, drawStart.y, e.clientX, e.clientY);
      Object.assign(drawRect.style, {
        display: 'block',
        left: r.x + 'px',
        top: r.y + 'px',
        width: r.width + 'px',
        height: r.height + 'px',
      } as CSSStyleDeclaration);
      return;
    }
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
    // Picker and region-draw are mutually exclusive.
    if (drawing)
      stopDrawing();
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

  // ---- Region-draw mode (mutually exclusive with the picker) ----
  function startDrawing() {
    if (picking)
      stopPicking();
    drawing = true;
    drawActive = false;
    drawStart = null;
    document.documentElement.style.cursor = 'crosshair';
    document.body.style.cursor = 'crosshair';
    drawRect.style.display = 'none';
  }

  function stopDrawing() {
    drawing = false;
    drawActive = false;
    drawStart = null;
    document.documentElement.style.cursor = '';
    document.body.style.cursor = '';
    drawRect.style.display = 'none';
  }

  // Normalize two corner points into a positive-dimension rect (any drag dir).
  function normRect(ax: number, ay: number, bx: number, by: number) {
    const x = Math.min(ax, bx);
    const y = Math.min(ay, by);
    const width = Math.abs(bx - ax);
    const height = Math.abs(by - ay);
    return { x, y, width, height };
  }

  function onMouseDown(e: MouseEvent) {
    if (!drawing)
      return;
    if (isOwnNode(e.target as Element))
      return;
    e.preventDefault();
    e.stopPropagation();
    drawActive = true;
    drawStart = { x: e.clientX, y: e.clientY };
    Object.assign(drawRect.style, {
      display: 'block',
      left: e.clientX + 'px',
      top: e.clientY + 'px',
      width: '0px',
      height: '0px',
    } as CSSStyleDeclaration);
  }

  function onMouseUp(e: MouseEvent) {
    if (!drawing || !drawActive || !drawStart)
      return;
    e.preventDefault();
    e.stopPropagation();
    const r = normRect(drawStart.x, drawStart.y, e.clientX, e.clientY);
    // Too small → treat as a cancel (a stray click rather than a deliberate drag).
    if (r.width < 8 || r.height < 8) {
      stopDrawing();
      return;
    }
    stopDrawing();
    // openPanel() → closePanel() resets captureKind/drawnRect, so commit the
    // region state AFTER the panel is (re)built, otherwise doSend() reads null.
    openPanel();
    drawnRect = { x: r.x, y: r.y, width: r.width, height: r.height };
    captureKind = 'region';
  }

  // ---- The Clorch-styled panel ----
  const CONFIRM_HINT = 'Ctrl/Cmd+Shift+K pick · +Shift+D region · Esc close';
  let panel: HTMLElement | null = null;
  let inputEl: HTMLInputElement | null = null;
  // Drag + resize bookkeeping (panel is rebuilt each open; observer/flag reset).
  let draggingPanel = false;
  let dragOffset = { x: 0, y: 0 };
  let resizeObserver: ResizeObserver | null = null;
  let resizeSaveTimer: number | null = null;

  function buildPanel() {
    const root = document.createElement('div');
    root.className = NS + 'panel';
    Object.assign(root.style, {
      position: 'fixed',
      right: '20px',
      bottom: '20px',
      zIndex: String(Z),
      width: DEFAULT_WIDTH + 'px',
      background: tk('overlayBg'),
      borderRadius: '12px',
      boxShadow: '0 30px 80px -30px rgba(0,0,0,0.8), 0 0 0 1px rgba(196,240,0,0.08)',
      padding: '14px 16px',
      font: '12.5px ' + T.mono,
      color: tk('ink'),
      // Native adjustable resize from the bottom-right corner.
      resize: 'both',
      overflow: 'hidden',
      minWidth: '320px',
    } as CSSStyleDeclaration);

    // Apply persisted size first (so resize starts from the saved footprint).
    if (savedSize) {
      root.style.width = savedSize.width + 'px';
      root.style.height = savedSize.height + 'px';
    }
    // Apply persisted position: convert from the default right/bottom anchor to
    // left/top and clamp into the viewport in case it was saved off-screen.
    if (savedPos) {
      const w = savedSize ? savedSize.width : DEFAULT_WIDTH;
      const { left, top } = clampToViewport(savedPos.left, savedPos.top, w);
      root.style.left = left + 'px';
      root.style.top = top + 'px';
      root.style.right = 'auto';
      root.style.bottom = 'auto';
    }

    // Header row: diamond mark + eyebrow title + gear + connection dot.
    // Doubles as the drag handle.
    const header = document.createElement('div');
    header.className = NS + 'header';
    Object.assign(header.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      marginBottom: '10px',
      cursor: 'grab',
      userSelect: 'none',
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
      color: tk('muted'),
      flex: '1',
    } as CSSStyleDeclaration);

    // Gear button — toggles the settings section. Not part of the drag handle.
    const gear = document.createElement('button');
    gear.className = NS + 'gear';
    gear.type = 'button';
    gear.title = 'HUD settings';
    gear.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">' +
      '<path fill="currentColor" d="M19.14 12.94a7.49 7.49 0 0 0 .05-.94 7.49 7.49 0 0 0-.05-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.61-.22l-2.39.96a7.03 7.03 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54a7.03 7.03 0 0 0-1.62.94l-2.39-.96a.5.5 0 0 0-.61.22L2.29 8.84a.5.5 0 0 0 .12.64l2.03 1.58c-.03.31-.05.62-.05.94s.02.63.05.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.14.24.42.32.66.22l2.39-.96c.5.38 1.04.7 1.62.94l.36 2.54c.04.24.25.42.5.42h3.84c.25 0 .46-.18.5-.42l.36-2.54c.58-.24 1.12-.56 1.62-.94l2.39.96c.24.1.52.02.66-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7Z"/></svg>';
    Object.assign(gear.style, {
      background: 'transparent',
      border: 'none',
      padding: '2px',
      lineHeight: '0',
      cursor: 'pointer',
      color: tk('muted'),
      display: 'inline-flex',
      alignItems: 'center',
    } as CSSStyleDeclaration);
    gear.addEventListener('mouseenter', () => { gear.style.color = tk('accent'); });
    gear.addEventListener('mouseleave', () => { gear.style.color = tk('muted'); });

    dotEl = document.createElement('span');
    dotEl.className = NS + 'dot';
    Object.assign(dotEl.style, {
      width: '8px',
      height: '8px',
      borderRadius: '9999px',
      background: connected ? tk('accent') : tk('dim'),
      boxShadow: connected ? '0 0 0 3px rgba(196,240,0,0.15)' : 'none',
      display: 'inline-block',
    } as CSSStyleDeclaration);

    header.appendChild(markWrap);
    header.appendChild(title);
    header.appendChild(gear);
    header.appendChild(dotEl);

    // Header is the drag handle. Clicks on the gear must not start a drag.
    header.addEventListener('mousedown', e => {
      if (e.target === gear || (e.target as Element)?.closest?.('.' + NS + 'gear'))
        return;
      onDragStart(e, root);
    });

    // Selected element readout.
    const readout = document.createElement('div');
    readout.className = NS + 'readout';
    Object.assign(readout.style, {
      background: tk('cardBg'),
      border: '1px solid ' + tk('limeBorder'),
      borderRadius: '6px',
      padding: '7px 10px',
      marginBottom: '10px',
      font: '11px ' + T.mono,
      color: tk('muted'),
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
      background: tk('inputBg'),
      border: '1px solid ' + (settings.theme === 'light' ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.08)'),
      borderRadius: '6px',
      padding: '7px 10px',
      font: '12.5px ' + T.mono,
      color: tk('ink'),
      outline: 'none',
      marginBottom: '10px',
    } as CSSStyleDeclaration);
    input.addEventListener('focus', () => {
      input.style.borderColor = 'rgba(196,240,0,0.6)';
    });
    input.addEventListener('blur', () => {
      input.style.borderColor = settings.theme === 'light' ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.08)';
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
      color: tk('dim'),
    } as CSSStyleDeclaration);
    confirm.textContent = CONFIRM_HINT;

    const sendBtn = document.createElement('button');
    sendBtn.className = NS + 'send';
    sendBtn.textContent = 'Send ⏎';
    Object.assign(sendBtn.style, {
      background: 'rgba(196,240,0,0.1)',
      color: tk('accent'),
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

    // Collapsible settings section (hidden by default; gear toggles it).
    const settingsEl = buildSettings(root, readout, confirm);

    gear.addEventListener('click', () => {
      const shown = settingsEl.style.display !== 'none';
      settingsEl.style.display = shown ? 'none' : 'block';
      gear.style.color = shown ? tk('muted') : tk('accent');
    });

    root.appendChild(header);
    root.appendChild(readout);
    root.appendChild(input);
    root.appendChild(footer);
    root.appendChild(settingsEl);

    // Persist size changes (debounced) from the native resize handle.
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        if (resizeSaveTimer !== null)
          clearTimeout(resizeSaveTimer);
        resizeSaveTimer = window.setTimeout(() => {
          const r = root.getBoundingClientRect();
          savedSize = { width: Math.round(r.width), height: Math.round(r.height) };
          try {
            localStorage.setItem(LS_SIZE, JSON.stringify(savedSize));
          } catch (err) {
            // eslint-disable-next-line no-console
            console.warn('[clorch-hud] storage unavailable (save size):', err);
          }
        }, 250);
      });
      resizeObserver.observe(root);
    }

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

  // ---- Settings section (collapsible, persisted to localStorage) ----
  function buildSettings(root: HTMLElement, readout: HTMLElement, confirmEl: HTMLElement): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = NS + 'settings';
    Object.assign(wrap.style, {
      display: 'none',
      marginTop: '10px',
      paddingTop: '10px',
      borderTop: '1px solid ' + tk('limeBorder'),
      font: '11px ' + T.mono,
      color: tk('muted'),
    } as CSSStyleDeclaration);

    const rowStyle = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '10px',
      marginBottom: '8px',
    } as CSSStyleDeclaration;

    const labelStyle = {
      color: tk('muted'),
      flex: '1',
    } as CSSStyleDeclaration;

    // 1. Attach screenshot toggle.
    const rShot = document.createElement('label');
    Object.assign(rShot.style, rowStyle);
    const lShot = document.createElement('span');
    lShot.textContent = 'Attach screenshot';
    Object.assign(lShot.style, labelStyle);
    const cbShot = document.createElement('input');
    cbShot.type = 'checkbox';
    cbShot.checked = settings.attachShot;
    cbShot.addEventListener('change', () => {
      settings.attachShot = cbShot.checked;
      saveSettings();
    });
    rShot.appendChild(lShot);
    rShot.appendChild(cbShot);

    // 2. Capture padding (px), 0–200.
    const rPad = document.createElement('label');
    Object.assign(rPad.style, rowStyle);
    const lPad = document.createElement('span');
    lPad.textContent = 'Capture padding (px)';
    Object.assign(lPad.style, labelStyle);
    const inPad = document.createElement('input');
    inPad.type = 'number';
    inPad.min = '0';
    inPad.max = '200';
    inPad.value = String(settings.pad);
    Object.assign(inPad.style, {
      width: '64px',
      boxSizing: 'border-box',
      background: tk('inputBg'),
      border: '1px solid ' + tk('limeBorder'),
      borderRadius: '4px',
      padding: '3px 6px',
      font: '11px ' + T.mono,
      color: tk('ink'),
      outline: 'none',
    } as CSSStyleDeclaration);
    inPad.addEventListener('change', () => {
      const v = clampPad(Number(inPad.value));
      settings.pad = v;
      inPad.value = String(v);
      saveSettings();
    });
    rPad.appendChild(lPad);
    rPad.appendChild(inPad);

    // 3. Theme (Dark / Light).
    const rTheme = document.createElement('label');
    Object.assign(rTheme.style, rowStyle);
    const lTheme = document.createElement('span');
    lTheme.textContent = 'Theme';
    Object.assign(lTheme.style, labelStyle);
    const selTheme = document.createElement('select');
    Object.assign(selTheme.style, selectStyle());
    [['dark', 'Dark'], ['light', 'Light']].forEach(opt => {
      const o = document.createElement('option');
      o.value = opt[0];
      o.textContent = opt[1];
      if (settings.theme === opt[0])
        o.selected = true;
      selTheme.appendChild(o);
    });
    selTheme.addEventListener('change', () => {
      settings.theme = selTheme.value === 'light' ? 'light' : 'dark';
      saveSettings();
      // Re-render the panel so all theme tokens re-apply consistently.
      openPanel();
    });
    rTheme.appendChild(lTheme);
    rTheme.appendChild(selTheme);

    // 4. Default mode (Element / Region).
    const rMode = document.createElement('label');
    Object.assign(rMode.style, rowStyle);
    const lMode = document.createElement('span');
    lMode.textContent = 'Default mode';
    Object.assign(lMode.style, labelStyle);
    const selMode = document.createElement('select');
    Object.assign(selMode.style, selectStyle());
    [['element', 'Element'], ['region', 'Region']].forEach(opt => {
      const o = document.createElement('option');
      o.value = opt[0];
      o.textContent = opt[1];
      if (settings.defaultMode === opt[0])
        o.selected = true;
      selMode.appendChild(o);
    });
    selMode.addEventListener('change', () => {
      settings.defaultMode = selMode.value === 'region' ? 'region' : 'element';
      saveSettings();
    });
    rMode.appendChild(lMode);
    rMode.appendChild(selMode);

    // 5. Reset position & size.
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = NS + 'reset';
    resetBtn.textContent = 'Reset position & size';
    Object.assign(resetBtn.style, {
      width: '100%',
      background: 'transparent',
      color: tk('muted'),
      border: '1px solid ' + tk('limeBorder'),
      borderRadius: '6px',
      padding: '6px 10px',
      font: '10.5px ' + T.mono,
      letterSpacing: '.06em',
      cursor: 'pointer',
      marginTop: '2px',
    } as CSSStyleDeclaration);
    resetBtn.addEventListener('mouseenter', () => { resetBtn.style.color = tk('accent'); });
    resetBtn.addEventListener('mouseleave', () => { resetBtn.style.color = tk('muted'); });
    resetBtn.addEventListener('click', () => {
      savedPos = null;
      savedSize = null;
      try {
        localStorage.removeItem(LS_POS);
        localStorage.removeItem(LS_SIZE);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[clorch-hud] storage unavailable (reset geometry):', err);
      }
      // Restore the live panel to the default bottom-right anchor + width.
      root.style.left = 'auto';
      root.style.top = 'auto';
      root.style.right = '20px';
      root.style.bottom = '20px';
      root.style.width = DEFAULT_WIDTH + 'px';
      root.style.height = 'auto';
    });

    wrap.appendChild(rShot);
    wrap.appendChild(rPad);
    wrap.appendChild(rTheme);
    wrap.appendChild(rMode);
    wrap.appendChild(resetBtn);
    return wrap;
  }

  function selectStyle(): CSSStyleDeclaration {
    return {
      background: tk('inputBg'),
      border: '1px solid ' + tk('limeBorder'),
      borderRadius: '4px',
      padding: '3px 6px',
      font: '11px ' + T.mono,
      color: tk('ink'),
      outline: 'none',
      cursor: 'pointer',
    } as CSSStyleDeclaration;
  }

  // Clamp a desired left/top so at least the header stays on-screen.
  function clampToViewport(left: number, top: number, width: number): { left: number; top: number } {
    const vw = window.innerWidth || document.documentElement.clientWidth || 0;
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    // Keep at least a header-strip's worth visible on every edge.
    const minVisible = 40;
    const maxLeft = Math.max(0, vw - minVisible);
    const maxTop = Math.max(0, vh - minVisible);
    const minLeft = -(Math.max(0, width - minVisible));
    const clampedLeft = Math.min(maxLeft, Math.max(minLeft, left));
    const clampedTop = Math.min(maxTop, Math.max(0, top));
    return { left: Math.round(clampedLeft), top: Math.round(clampedTop) };
  }

  // ---- Panel drag (header handle only) ----
  function onDragStart(e: MouseEvent, root: HTMLElement) {
    e.preventDefault();
    const rect = root.getBoundingClientRect();
    // Convert right/bottom anchoring to left/top so the panel doesn't jump.
    root.style.left = rect.left + 'px';
    root.style.top = rect.top + 'px';
    root.style.right = 'auto';
    root.style.bottom = 'auto';
    dragOffset = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    draggingPanel = true;
    const header = root.querySelector<HTMLElement>('.' + NS + 'header');
    if (header)
      header.style.cursor = 'grabbing';

    const onMove = (ev: MouseEvent) => {
      if (!draggingPanel)
        return;
      const w = root.getBoundingClientRect().width;
      const { left, top } = clampToViewport(ev.clientX - dragOffset.x, ev.clientY - dragOffset.y, w);
      root.style.left = left + 'px';
      root.style.top = top + 'px';
    };
    const onUp = () => {
      if (!draggingPanel)
        return;
      draggingPanel = false;
      if (header)
        header.style.cursor = 'grab';
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mouseup', onUp, true);
      const rr = root.getBoundingClientRect();
      savedPos = { left: Math.round(rr.left), top: Math.round(rr.top) };
      try {
        localStorage.setItem(LS_POS, JSON.stringify(savedPos));
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[clorch-hud] storage unavailable (save pos):', err);
      }
    };
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mouseup', onUp, true);
  }

  function selectedReadout(): string {
    if (captureKind === 'region' && drawnRect)
      return 'Region ' + Math.round(drawnRect.width) + '×' + Math.round(drawnRect.height) + ' px';
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
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
    if (resizeSaveTimer !== null) {
      clearTimeout(resizeSaveTimer);
      resizeSaveTimer = null;
    }
    draggingPanel = false;
    if (panel && panel.parentNode)
      panel.parentNode.removeChild(panel);
    panel = null;
    inputEl = null;
    currentReadout = null;
    // Region selection is single-use; revert to element mode on close.
    captureKind = 'element';
    drawnRect = null;
  }

  function doSend(confirmEl: HTMLElement) {
    if (!inputEl)
      return;
    const message = inputEl.value.trim();
    if (!message)
      return;
    let payload: any;
    if (captureKind === 'region' && drawnRect) {
      payload = {
        type: 'hud_message',
        selector: '',
        tag: 'region',
        text: '',
        message,
        url: location.href,
        wantsShot: settings.attachShot,
        pad: settings.pad,
        bbox: {
          x: drawnRect.x,
          y: drawnRect.y,
          width: drawnRect.width,
          height: drawnRect.height,
          dpr: window.devicePixelRatio || 1,
        },
      };
    } else {
      const rect = selected ? selected.el.getBoundingClientRect() : null;
      payload = {
        type: 'hud_message',
        selector: selected ? selected.selector : '',
        tag: selected ? selected.tag : '',
        text: selected ? selected.text : '',
        message,
        url: location.href,
        wantsShot: settings.attachShot,
        pad: settings.pad,
        bbox: rect ? {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          dpr: window.devicePixelRatio || 1,
        } : null,
      };
    }
    const ok = sendMessage(payload);
    if (ok) {
      inputEl.value = '';
      confirmEl.textContent = 'sent ✓';
      confirmEl.style.color = tk('accent');
      // Reset to element mode after a successful region send.
      captureKind = 'element';
      drawnRect = null;
      setTimeout(() => {
        if (confirmEl.isConnected) {
          confirmEl.textContent = CONFIRM_HINT;
          confirmEl.style.color = tk('dim');
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
    if (mod && (e.key === 'D' || e.key === 'd')) {
      e.preventDefault();
      e.stopPropagation();
      if (drawing)
        stopDrawing();
      else
        startDrawing();
      return;
    }
    if (e.key === 'Escape') {
      if (drawing) {
        e.preventDefault();
        stopDrawing();
      } else if (picking) {
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
    document.body.appendChild(drawRect);
    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('mouseup', onMouseUp, true);
    document.addEventListener('click', onClickCapture, true);
    document.addEventListener('keydown', onKeyDown, true);
    connect();
  }

  install();

  // Expose a tiny programmatic API for the activation tool / debugging.
  w.__clorchHud = {
    openPicker: startPicking,
    openDrawMode: startDrawing,
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
