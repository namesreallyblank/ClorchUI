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

type Rating = 'good' | 'needs-improvement' | 'poor';

interface MetricResult {
  value: number | null;
  rating: Rating | null;
}

interface LongTask {
  startTime: number;
  duration: number;
  name: string;
}

interface PerformanceMetrics {
  lcp: MetricResult;
  cls: MetricResult;
  fcp: MetricResult;
  ttfb: MetricResult;
  inp: MetricResult;
  domContentLoaded: number | null;
  domInteractive: number | null;
  longTasks: LongTask[];
  longTasksTotal: {
    count: number;
    totalDurationMs: number;
  };
  resources: {
    count: number;
    totalSize: number;
  };
}

function rateLCP(value: number | null): Rating | null {
  if (value === null) return null;
  if (value < 2500) return 'good';
  if (value < 4000) return 'needs-improvement';
  return 'poor';
}

function rateCLS(value: number | null): Rating | null {
  if (value === null) return null;
  if (value < 0.1) return 'good';
  if (value < 0.25) return 'needs-improvement';
  return 'poor';
}

function rateFCP(value: number | null): Rating | null {
  if (value === null) return null;
  if (value < 1800) return 'good';
  if (value < 3000) return 'needs-improvement';
  return 'poor';
}

function rateTTFB(value: number | null): Rating | null {
  if (value === null) return null;
  if (value < 800) return 'good';
  if (value < 1800) return 'needs-improvement';
  return 'poor';
}

function rateINP(value: number | null): Rating | null {
  if (value === null) return null;
  if (value <= 200) return 'good';
  if (value <= 500) return 'needs-improvement';
  return 'poor';
}

const performanceMetrics = defineTabTool({
  capability: 'core',

  schema: {
    name: 'uiux_performance_metrics',
    title: 'Collect Core Web Vitals',
    description: 'Collects Core Web Vitals performance metrics (LCP, CLS, FCP, TTFB) and resource statistics',
    inputSchema: z.object({
      waitForLoad: z.boolean().optional().describe('Wait for page load before collecting metrics. Defaults to false.'),
    }),
    type: 'readOnly',
  },

  handle: async (tab, params, response) => {
    if (params.waitForLoad) {
      await tab.page.waitForLoadState('load');
    }

    const rawMetrics = await tab.page.evaluate(async () => {
      const paintEntries = performance.getEntriesByType('paint');
      const fcpEntry = paintEntries.find(e => e.name === 'first-contentful-paint');

      const lcpEntries = performance.getEntriesByType('largest-contentful-paint') as PerformanceEntry[];
      const lcpEntry = lcpEntries.length ? lcpEntries[lcpEntries.length - 1] : null;

      const clsEntries = performance.getEntriesByType('layout-shift') as (PerformanceEntry & { hadRecentInput?: boolean; value?: number })[];
      const clsValue = clsEntries.reduce((sum, e) => sum + (e.hadRecentInput ? 0 : (e.value || 0)), 0);

      const navEntries = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
      const nav = navEntries.length ? navEntries[0] : null;
      const ttfbValue = nav ? nav.responseStart - nav.requestStart : null;
      const domContentLoaded = nav ? nav.domContentLoadedEventEnd : null;
      const domInteractive = nav ? nav.domInteractive : null;

      const resourceEntries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
      const resourceCount = resourceEntries.length;
      const totalSize = resourceEntries.reduce((sum, r) => sum + (r.transferSize || 0), 0);

      // Collect event entries (for INP) and longtask entries via PerformanceObserver with buffered flag.
      // Some browsers don't support these types; guard each observer independently.
      const eventDurations: number[] = [];
      try {
        await new Promise<void>(resolve => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            resolve();
          };
          try {
            const obs = new PerformanceObserver(list => {
              for (const entry of list.getEntries()) {
                const dur = (entry as PerformanceEntry & { duration: number }).duration;
                if (typeof dur === 'number' && dur > 0)
                  eventDurations.push(dur);
              }
              obs.disconnect();
              finish();
            });
            obs.observe({ type: 'event', buffered: true } as PerformanceObserverInit);
            // Short timeout in case no buffered entries are flushed.
            setTimeout(() => { try { obs.disconnect(); } catch (err) { /* ignore */ } finish(); }, 50);
          } catch (err) {
            finish();
          }
        });
      } catch (err) {
        // Event Timing API not supported; leave eventDurations empty.
      }

      const longTasksRaw: Array<{ startTime: number; duration: number; name: string }> = [];
      try {
        await new Promise<void>(resolve => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            resolve();
          };
          try {
            const obs = new PerformanceObserver(list => {
              for (const entry of list.getEntries()) {
                longTasksRaw.push({
                  startTime: entry.startTime,
                  duration: entry.duration,
                  name: entry.name,
                });
              }
              obs.disconnect();
              finish();
            });
            obs.observe({ type: 'longtask', buffered: true } as PerformanceObserverInit);
            setTimeout(() => { try { obs.disconnect(); } catch (err) { /* ignore */ } finish(); }, 50);
          } catch (err) {
            finish();
          }
        });
      } catch (err) {
        // Long Tasks API not supported.
      }

      // INP calculation per Web Vitals: max interaction if <50 samples, else 98th percentile.
      let inpValue: number | null = null;
      if (eventDurations.length > 0) {
        const sorted = eventDurations.slice().sort((a, b) => a - b);
        if (sorted.length < 50) {
          inpValue = sorted[sorted.length - 1];
        } else {
          const idx = Math.floor(sorted.length * 0.98);
          inpValue = sorted[Math.min(idx, sorted.length - 1)];
        }
      }

      longTasksRaw.sort((a, b) => b.startTime - a.startTime);
      const longTasks = longTasksRaw.slice(0, 20);
      const longTasksTotal = {
        count: longTasksRaw.length,
        totalDurationMs: longTasksRaw.reduce((sum, t) => sum + t.duration, 0),
      };

      return {
        fcp: fcpEntry ? fcpEntry.startTime : null,
        lcp: lcpEntry ? (lcpEntry as PerformanceEntry & { startTime: number }).startTime : null,
        cls: clsValue,
        ttfb: ttfbValue,
        inp: inpValue,
        domContentLoaded,
        domInteractive,
        longTasks,
        longTasksTotal,
        resourceCount,
        totalSize,
      };
    });

    const metrics: PerformanceMetrics = {
      lcp: {
        value: rawMetrics.lcp,
        rating: rateLCP(rawMetrics.lcp),
      },
      cls: {
        value: rawMetrics.cls,
        rating: rateCLS(rawMetrics.cls),
      },
      fcp: {
        value: rawMetrics.fcp,
        rating: rateFCP(rawMetrics.fcp),
      },
      ttfb: {
        value: rawMetrics.ttfb,
        rating: rateTTFB(rawMetrics.ttfb),
      },
      inp: {
        value: rawMetrics.inp,
        rating: rateINP(rawMetrics.inp),
      },
      domContentLoaded: rawMetrics.domContentLoaded,
      domInteractive: rawMetrics.domInteractive,
      longTasks: rawMetrics.longTasks,
      longTasksTotal: rawMetrics.longTasksTotal,
      resources: {
        count: rawMetrics.resourceCount,
        totalSize: rawMetrics.totalSize,
      },
    };

    const lines: string[] = [
      '## Core Web Vitals',
      '',
      `**LCP (Largest Contentful Paint):** ${metrics.lcp.value !== null ? `${metrics.lcp.value.toFixed(0)}ms` : 'N/A'} [${metrics.lcp.rating || 'N/A'}]`,
      `**FCP (First Contentful Paint):** ${metrics.fcp.value !== null ? `${metrics.fcp.value.toFixed(0)}ms` : 'N/A'} [${metrics.fcp.rating || 'N/A'}]`,
      `**CLS (Cumulative Layout Shift):** ${metrics.cls.value !== null ? metrics.cls.value.toFixed(3) : 'N/A'} [${metrics.cls.rating || 'N/A'}]`,
      `**TTFB (Time to First Byte):** ${metrics.ttfb.value !== null ? `${metrics.ttfb.value.toFixed(0)}ms` : 'N/A'} [${metrics.ttfb.rating || 'N/A'}]`,
      `**INP (Interaction to Next Paint):** ${metrics.inp.value !== null ? `${metrics.inp.value.toFixed(0)}ms` : 'N/A'} [${metrics.inp.rating || 'N/A'}]`,
      '',
      '## Navigation Timing',
      '',
      `**DOMContentLoaded:** ${metrics.domContentLoaded !== null ? `${metrics.domContentLoaded.toFixed(0)}ms` : 'N/A'}`,
      `**DOM Interactive:** ${metrics.domInteractive !== null ? `${metrics.domInteractive.toFixed(0)}ms` : 'N/A'}`,
      '',
      '## Long Tasks',
      '',
      `**Count:** ${metrics.longTasksTotal.count}`,
      `**Total Duration:** ${metrics.longTasksTotal.totalDurationMs.toFixed(0)}ms`,
      '',
      '## Resources',
      '',
      `**Count:** ${metrics.resources.count}`,
      `**Total Size:** ${(metrics.resources.totalSize / 1024).toFixed(1)} KB`,
      '',
      '## Raw Data',
      '',
      '```json',
      JSON.stringify(metrics, null, 2),
      '```',
    ];

    response.addTextResult(lines.join('\n'));
  },
});

export default [
  performanceMetrics,
];
