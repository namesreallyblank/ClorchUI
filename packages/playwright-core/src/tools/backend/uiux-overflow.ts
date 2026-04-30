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

import * as z from 'zod';
import { defineTabTool } from './tool';

const DEFAULT_VIEWPORTS = [375, 768, 1024, 1440];
const DEFAULT_HEIGHT = 800;

const overflowAudit = defineTabTool({
  capability: 'core',
  schema: {
    name: 'uiux_overflow_audit',
    title: 'Viewport overflow audit',
    description: 'Tests multiple viewport widths and reports elements that cause horizontal scroll or self-overflow',
    inputSchema: z.object({
      viewports: z.array(z.number()).optional().describe('Viewport widths in pixels to test (default: 375, 768, 1024, 1440)'),
      settleTimeMs: z.number().optional().describe('Delay after resize before measuring, in ms (default: 300)'),
    }),
    type: 'action',
  },

  handle: async (tab, params, response) => {
    const viewports = params.viewports && params.viewports.length > 0 ? params.viewports : DEFAULT_VIEWPORTS;
    const settleTimeMs = params.settleTimeMs ?? 300;
    const originalViewport = tab.page.viewportSize();

    type Offender = {
      selector: string;
      tagName: string;
      class: string;
      rect: { x: number; y: number; width: number; height: number };
      overflow: 'viewport' | 'self';
      excessPx: number;
    };
    type ViewportResult = {
      width: number;
      globalHorizontalScroll: boolean;
      offenders: Offender[];
    };

    const results: ViewportResult[] = [];

    try {
      for (const width of viewports) {
        await tab.page.setViewportSize({ width, height: DEFAULT_HEIGHT });
        await tab.page.waitForTimeout(settleTimeMs);

        const viewportResult = await tab.page.evaluate((vw: number) => {
          const buildSelectorPath = (el: Element): string => {
            const parts: string[] = [];
            let current: Element | null = el;
            let depth = 0;
            while (current && depth < 4) {
              let part = current.tagName.toLowerCase();
              if (current.id) {
                part += `#${current.id}`;
                parts.unshift(part);
                break;
              }
              const cls = Array.from(current.classList).slice(0, 2).join('.');
              if (cls) part += `.${cls}`;
              parts.unshift(part);
              current = current.parentElement;
              depth++;
            }
            return parts.join(' > ');
          };

          const isHidden = (el: Element): boolean => {
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') return true;
            if (el.getAttribute('aria-hidden') === 'true') return true;
            return false;
          };

          const offenders: Array<{
            selector: string;
            tagName: string;
            class: string;
            rect: { x: number; y: number; width: number; height: number };
            overflow: 'viewport' | 'self';
            excessPx: number;
          }> = [];

          const docEl = document.documentElement;
          const body = document.body;
          const globalHorizontalScroll =
            (docEl.scrollWidth > docEl.clientWidth) ||
            (body ? body.scrollWidth > body.clientWidth : false);

          const allElements = document.querySelectorAll('*');
          allElements.forEach(el => {
            if (el === docEl || el === body) return;
            if (isHidden(el)) return;

            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return;

            const viewportExcess = rect.right - vw;
            const selfExcess = el.scrollWidth - el.clientWidth;

            if (viewportExcess > 0) {
              offenders.push({
                selector: buildSelectorPath(el),
                tagName: el.tagName.toLowerCase(),
                class: typeof el.className === 'string' ? el.className : '',
                rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                overflow: 'viewport',
                excessPx: Math.round(viewportExcess),
              });
            } else if (selfExcess > 0) {
              offenders.push({
                selector: buildSelectorPath(el),
                tagName: el.tagName.toLowerCase(),
                class: typeof el.className === 'string' ? el.className : '',
                rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                overflow: 'self',
                excessPx: Math.round(selfExcess),
              });
            }
          });

          offenders.sort((a, b) => b.excessPx - a.excessPx);
          return {
            width: vw,
            globalHorizontalScroll,
            offenders: offenders.slice(0, 20),
          };
        }, width);

        results.push(viewportResult);
      }
    } finally {
      if (originalViewport) {
        await tab.page.setViewportSize(originalViewport).catch(() => {});
      }
    }

    const totalOffenders = results.reduce((sum, r) => sum + r.offenders.length, 0);
    let worstViewport: number | null = null;
    let worstCount = -1;
    for (const r of results) {
      if (r.offenders.length > worstCount) {
        worstCount = r.offenders.length;
        worstViewport = r.width;
      }
    }

    const output = {
      viewports: results,
      summary: {
        totalOffenders,
        worstViewport,
      },
    };

    response.addCode(`// Audited ${viewports.length} viewport${viewports.length === 1 ? '' : 's'} for overflow`);
    response.addTextResult(JSON.stringify(output, null, 2));
  },
});

export default [overflowAudit];
