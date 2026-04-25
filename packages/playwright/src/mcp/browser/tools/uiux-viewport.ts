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
import { dateAsFileName } from './utils';

const DEFAULT_VIEWPORTS = [375, 768, 1024, 1440];
const DEFAULT_HEIGHT = 800;

const viewportMatrix = defineTabTool({
  capability: 'core',
  schema: {
    name: 'uiux_viewport_matrix',
    title: 'Structured responsive analysis across viewports',
    description: 'Measures document dimensions, overflow, font distribution, CLS, and fold metrics across multiple viewport widths. Complements uiux_responsive_preview with structured data.',
    inputSchema: z.object({
      viewports: z.array(z.number()).optional().describe('Viewport widths in pixels (default: 375, 768, 1024, 1440)'),
      captureScreenshot: z.boolean().optional().describe('Include screenshots per viewport. Requires vision capability. Defaults to false.'),
      settleTimeMs: z.number().optional().describe('Delay after resize before measuring, in ms (default: 400)'),
    }),
    type: 'action',
  },

  handle: async (tab, params, response) => {
    const viewports = params.viewports && params.viewports.length > 0 ? params.viewports : DEFAULT_VIEWPORTS;
    const captureScreenshot = params.captureScreenshot ?? false;
    const settleTimeMs = params.settleTimeMs ?? 400;

    if (captureScreenshot) {
      const caps = tab.context.config.capabilities || [];
      if (!caps.includes('vision')) {
        response.addError('uiux_viewport_matrix: captureScreenshot=true requires the "vision" capability. Re-run with captureScreenshot=false, or enable the vision capability in config.');
        return;
      }
    }

    type LayoutBreak = { selector: string; right: number };
    type ViewportResult = {
      width: number;
      height: number;
      documentDimensions: { scrollWidth: number; scrollHeight: number; clientWidth: number; clientHeight: number };
      hasHorizontalScroll: boolean;
      layoutBreaks: { count: number; topSelectors: string[] };
      fontSizeDistribution: Record<string, number>;
      cumulativeLayoutShift: number;
      visibleImages: number;
      interactivesBelowFold: number;
      screenshotPath?: string;
    };

    const results: ViewportResult[] = [];
    const originalViewport = tab.page.viewportSize();

    try {
      for (const width of viewports) {
        await tab.page.setViewportSize({ width, height: DEFAULT_HEIGHT });
        await tab.page.waitForTimeout(settleTimeMs);

        const measurement = await tab.page.evaluate((vw: number) => {
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

          const docEl = document.documentElement;
          const vh = window.innerHeight;

          const documentDimensions = {
            scrollWidth: docEl.scrollWidth,
            scrollHeight: docEl.scrollHeight,
            clientWidth: docEl.clientWidth,
            clientHeight: docEl.clientHeight,
          };

          const hasHorizontalScroll = docEl.scrollWidth > docEl.clientWidth;

          // Layout breaks: elements whose right edge exceeds viewport
          const layoutBreakList: Array<{ selector: string; right: number }> = [];
          const fontSizeDistribution: Record<string, number> = {};
          let interactivesBelowFold = 0;

          const allElements = document.querySelectorAll('*');
          allElements.forEach(el => {
            if (el === docEl || el === document.body) return;
            if (isHidden(el)) return;
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return;

            if (rect.right > vw) {
              layoutBreakList.push({ selector: buildSelectorPath(el), right: Math.round(rect.right) });
            }

            // Font size distribution: only text-bearing leaf-ish elements
            const hasDirectText = Array.from(el.childNodes).some(n => n.nodeType === Node.TEXT_NODE && n.textContent && n.textContent.trim().length > 0);
            if (hasDirectText) {
              const fontSizeStr = window.getComputedStyle(el).fontSize;
              const fontSize = parseFloat(fontSizeStr);
              if (!isNaN(fontSize)) {
                const bucket = String(Math.round(fontSize));
                fontSizeDistribution[bucket] = (fontSizeDistribution[bucket] || 0) + 1;
              }
            }

            // Interactives below fold
            const tag = el.tagName.toLowerCase();
            const isInteractive = tag === 'button' || tag === 'a'
              || (tag === 'input' && (el as HTMLInputElement).type !== 'hidden')
              || el.getAttribute('role') === 'button'
              || el.getAttribute('role') === 'link';
            if (isInteractive && rect.top > vh) interactivesBelowFold++;
          });

          layoutBreakList.sort((a, b) => b.right - a.right);
          const topBreakSelectors = layoutBreakList.slice(0, 5).map(b => b.selector);

          // Visible images
          const imgs = document.querySelectorAll('img');
          let visibleImages = 0;
          imgs.forEach(img => {
            const r = img.getBoundingClientRect();
            if (r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw) visibleImages++;
          });

          // CLS via layout-shift entries (session-window approximation: max 5s rolling window)
          let cumulativeLayoutShift = 0;
          try {
            const entries = performance.getEntriesByType('layout-shift') as PerformanceEntry[];
            if (entries && entries.length) {
              const shifts = entries as Array<PerformanceEntry & { value: number; hadRecentInput?: boolean; startTime: number }>;
              const filtered = shifts.filter(e => !e.hadRecentInput);
              // Session windows: group shifts within 1s gap and 5s total window, take max window sum
              let maxWindow = 0;
              let windowStart = 0;
              let lastTime = 0;
              let windowSum = 0;
              for (const e of filtered) {
                if (windowSum === 0) {
                  windowStart = e.startTime;
                  windowSum = e.value;
                  lastTime = e.startTime;
                  continue;
                }
                const gap = e.startTime - lastTime;
                const fromStart = e.startTime - windowStart;
                if (gap > 1000 || fromStart > 5000) {
                  if (windowSum > maxWindow) maxWindow = windowSum;
                  windowStart = e.startTime;
                  windowSum = e.value;
                } else {
                  windowSum += e.value;
                }
                lastTime = e.startTime;
              }
              if (windowSum > maxWindow) maxWindow = windowSum;
              cumulativeLayoutShift = Math.round(maxWindow * 10000) / 10000;
            }
          } catch (_err) {
            // layout-shift entries unavailable
          }

          return {
            height: vh,
            documentDimensions,
            hasHorizontalScroll,
            layoutBreaks: { count: layoutBreakList.length, topSelectors: topBreakSelectors },
            fontSizeDistribution,
            cumulativeLayoutShift,
            visibleImages,
            interactivesBelowFold,
          };
        }, width);

        const viewportResult: ViewportResult = {
          width,
          height: measurement.height,
          documentDimensions: measurement.documentDimensions,
          hasHorizontalScroll: measurement.hasHorizontalScroll,
          layoutBreaks: measurement.layoutBreaks,
          fontSizeDistribution: measurement.fontSizeDistribution,
          cumulativeLayoutShift: measurement.cumulativeLayoutShift,
          visibleImages: measurement.visibleImages,
          interactivesBelowFold: measurement.interactivesBelowFold,
        };

        if (captureScreenshot) {
          const screenshot = await tab.page.screenshot({ type: 'png', scale: 'css' });
          const filename = dateAsFileName(`viewport-matrix-${width}w`, 'png');
          await response.addResult(
              `Viewport ${width}px`,
              screenshot,
              { prefix: `viewport-matrix-${width}w`, ext: 'png', suggestedFilename: filename, contentType: 'image/png' }
          );
          viewportResult.screenshotPath = filename;
        }

        results.push(viewportResult);
      }
    } finally {
      if (originalViewport)
        await tab.page.setViewportSize(originalViewport).catch(() => {});
    }

    let worstCLS = 0;
    let anyHorizontalScroll = false;
    const viewportsWithBreaks: number[] = [];
    for (const r of results) {
      if (r.cumulativeLayoutShift > worstCLS) worstCLS = r.cumulativeLayoutShift;
      if (r.hasHorizontalScroll) anyHorizontalScroll = true;
      if (r.layoutBreaks.count > 0) viewportsWithBreaks.push(r.width);
    }

    const output = {
      viewports: results,
      summary: {
        worstCLS,
        anyHorizontalScroll,
        viewportsWithBreaks,
      },
    };

    response.addCode(`// Analyzed ${viewports.length} viewport${viewports.length === 1 ? '' : 's'}${captureScreenshot ? ' with screenshots' : ''}`);
    response.addTextResult(JSON.stringify(output, null, 2));
  },
});

export default [viewportMatrix];
