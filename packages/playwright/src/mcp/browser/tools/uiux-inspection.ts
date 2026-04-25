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

import { z } from 'playwright-core/lib/mcpBundle';
import { defineTabTool } from './tool';

const elementTargetSchema = z.object({
  ref: z.string().optional().describe('Element reference from the page snapshot'),
  selector: z.string().optional().describe('CSS selector to target the element'),
});

const inspectElement = defineTabTool({
  capability: 'core',
  schema: {
    name: 'uiux_inspect_element',
    title: 'Inspect element styles',
    description: 'Get computed styles and box model for an element',
    inputSchema: elementTargetSchema,
    type: 'readOnly',
  },
  handle: async (tab, params, response) => {
    const selector = params.selector || (params.ref ? `[aria-ref="${params.ref}"]` : 'body');
    const result = await tab.page.evaluate((sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const computed = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return {
        tagName: el.tagName.toLowerCase(),
        className: el.className,
        boxModel: {
          x: rect.x, y: rect.y, width: rect.width, height: rect.height,
          margin: { top: computed.marginTop, right: computed.marginRight, bottom: computed.marginBottom, left: computed.marginLeft },
          padding: { top: computed.paddingTop, right: computed.paddingRight, bottom: computed.paddingBottom, left: computed.paddingLeft },
          border: { top: computed.borderTopWidth, right: computed.borderRightWidth, bottom: computed.borderBottomWidth, left: computed.borderLeftWidth },
        },
        computedStyles: {
          display: computed.display, position: computed.position, flexDirection: computed.flexDirection,
          justifyContent: computed.justifyContent, alignItems: computed.alignItems,
          gridTemplateColumns: computed.gridTemplateColumns, gridTemplateRows: computed.gridTemplateRows,
          overflow: computed.overflow, zIndex: computed.zIndex, opacity: computed.opacity,
          visibility: computed.visibility, backgroundColor: computed.backgroundColor, color: computed.color,
          fontSize: computed.fontSize, fontWeight: computed.fontWeight, lineHeight: computed.lineHeight,
        },
      };
    }, selector);
    if (!result) { response.addTextResult(`Element not found: ${selector}`); return; }
    response.addTextResult(JSON.stringify(result, null, 2));
  },
});

const highlightElementSchema = elementTargetSchema.extend({
  color: z.string().optional().describe('Highlight color (default: rgba(255, 0, 0, 0.3))'),
});

const highlightElement = defineTabTool({
  capability: 'core',
  schema: {
    name: 'uiux_highlight_element',
    title: 'Highlight element',
    description: 'Inject CSS overlay showing margin, padding, and border of an element',
    inputSchema: highlightElementSchema,
    type: 'readOnly',
  },
  handle: async (tab, params, response) => {
    const selector = params.selector || (params.ref ? `[aria-ref="${params.ref}"]` : 'body');
    const color = params.color || 'rgba(255, 0, 0, 0.3)';
    const highlighted = await tab.page.evaluate(({ sel, highlightColor }: { sel: string; highlightColor: string }) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const existingOverlay = document.getElementById('__uiux_highlight_overlay__');
      if (existingOverlay) existingOverlay.remove();
      const computed = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const m = { top: parseFloat(computed.marginTop) || 0, right: parseFloat(computed.marginRight) || 0, bottom: parseFloat(computed.marginBottom) || 0, left: parseFloat(computed.marginLeft) || 0 };
      const p = { top: parseFloat(computed.paddingTop) || 0, right: parseFloat(computed.paddingRight) || 0, bottom: parseFloat(computed.paddingBottom) || 0, left: parseFloat(computed.paddingLeft) || 0 };
      const b = { top: parseFloat(computed.borderTopWidth) || 0, right: parseFloat(computed.borderRightWidth) || 0, bottom: parseFloat(computed.borderBottomWidth) || 0, left: parseFloat(computed.borderLeftWidth) || 0 };
      const overlay = document.createElement('div');
      overlay.id = '__uiux_highlight_overlay__';
      overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:999999;top:0;left:0;width:100%;height:100%';
      const createBox = (bg: string, top: number, left: number, width: number, height: number) => {
        const box = document.createElement('div');
        box.style.cssText = `position:absolute;background:${bg};top:${top}px;left:${left}px;width:${width}px;height:${height}px`;
        return box;
      };
      overlay.appendChild(createBox('rgba(255,165,0,0.3)', rect.top - m.top + window.scrollY, rect.left - m.left + window.scrollX, rect.width + m.left + m.right, rect.height + m.top + m.bottom));
      overlay.appendChild(createBox('rgba(255,255,0,0.3)', rect.top + window.scrollY, rect.left + window.scrollX, rect.width, rect.height));
      overlay.appendChild(createBox('rgba(0,128,0,0.3)', rect.top + b.top + window.scrollY, rect.left + b.left + window.scrollX, rect.width - b.left - b.right, rect.height - b.top - b.bottom));
      overlay.appendChild(createBox(highlightColor, rect.top + b.top + p.top + window.scrollY, rect.left + b.left + p.left + window.scrollX, rect.width - b.left - b.right - p.left - p.right, rect.height - b.top - b.bottom - p.top - p.bottom));
      document.body.appendChild(overlay);
      return true;
    }, { sel: selector, highlightColor: color });
    if (!highlighted) { response.addTextResult(`Element not found: ${selector}`); return; }
    response.addTextResult(JSON.stringify({ highlighted: true, selector }, null, 2));
  },
});

const layoutDebugSchema = z.object({
  showGrid: z.boolean().optional().describe('Highlight CSS Grid containers'),
  showFlex: z.boolean().optional().describe('Highlight Flexbox containers'),
});

const layoutDebug = defineTabTool({
  capability: 'core',
  schema: {
    name: 'uiux_layout_debug',
    title: 'Debug layout',
    description: 'Inject CSS to visualize grid and flexbox containers on the page',
    inputSchema: layoutDebugSchema,
    type: 'readOnly',
  },
  handle: async (tab, params, response) => {
    const showGrid = params.showGrid ?? true;
    const showFlex = params.showFlex ?? true;
    const result = await tab.page.evaluate(({ grid, flex }: { grid: boolean; flex: boolean }) => {
      const existingStyle = document.getElementById('__uiux_layout_debug_style__');
      if (existingStyle) existingStyle.remove();
      let gridCount = 0, flexCount = 0;
      const allElements = document.querySelectorAll('*');
      allElements.forEach(el => {
        const d = window.getComputedStyle(el).display;
        if (d === 'grid' || d === 'inline-grid') gridCount++;
        if (d === 'flex' || d === 'inline-flex') flexCount++;
      });
      if (!grid && !flex) return { grids: gridCount, flexes: flexCount };
      const styles: string[] = [];
      allElements.forEach(el => {
        const d = window.getComputedStyle(el).display;
        if (grid && (d === 'grid' || d === 'inline-grid')) el.classList.add('__uiux_grid_debug__');
        if (flex && (d === 'flex' || d === 'inline-flex')) el.classList.add('__uiux_flex_debug__');
      });
      if (grid) styles.push('.__uiux_grid_debug__{outline:2px dashed #9b59b6!important;outline-offset:-2px;position:relative}.__uiux_grid_debug__::before{content:"GRID";position:absolute;top:0;left:0;background:#9b59b6;color:#fff;font-size:10px;padding:1px 4px;z-index:999998}');
      if (flex) styles.push('.__uiux_flex_debug__{outline:2px dashed #3498db!important;outline-offset:-2px;position:relative}.__uiux_flex_debug__::before{content:"FLEX";position:absolute;top:0;right:0;background:#3498db;color:#fff;font-size:10px;padding:1px 4px;z-index:999998}');
      const styleEl = document.createElement('style');
      styleEl.id = '__uiux_layout_debug_style__';
      styleEl.textContent = styles.join('\n');
      document.head.appendChild(styleEl);
      return { grids: gridCount, flexes: flexCount };
    }, { grid: showGrid, flex: showFlex });
    response.addTextResult(JSON.stringify(result, null, 2));
  },
});

export default [inspectElement, highlightElement, layoutDebug];
