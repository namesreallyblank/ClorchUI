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

const DEFAULT_AXE_CORE_URL = 'https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.8.4/axe.min.js';
const AXE_CORE_URL = process.env.AXE_CORE_URL || DEFAULT_AXE_CORE_URL;

const accessibilityAudit = defineTabTool({
  capability: 'core',
  schema: {
    name: 'uiux_accessibility_audit',
    title: 'Accessibility Audit',
    description: 'Run axe-core accessibility audit on the page',
    inputSchema: z.object({
      scope: z.string().optional().describe('CSS selector to scope the audit to a specific element'),
    }),
    type: 'readOnly',
  },

  handle: async (tab, params, response) => {
    const page = tab.page;

    // Inject axe-core from CDN (or AXE_CORE_URL env override). CSP can block this.
    let injectError: string | null = null;
    try {
      await page.addScriptTag({ url: AXE_CORE_URL });
    } catch (err) {
      injectError = err instanceof Error ? err.message : String(err);
    }

    // Verify axe loaded; if not, report a helpful CSP-blocked error.
    const axeLoaded = await page.evaluate(() => typeof (window as any).axe !== 'undefined');

    if (!axeLoaded) {
      const detail = injectError ?? 'window.axe was undefined after script injection';
      const message =
        'AXE-CORE INJECTION FAILED\n\n' +
        `The page's Content Security Policy (or a network error) blocked loading axe-core from ${AXE_CORE_URL}.\n\n` +
        'Workarounds:\n' +
        '1. Start the MCP server with --init-script pointing to a local axe-core bundle\n' +
        '2. Set AXE_CORE_URL env var to a self-hosted axe-core bundle the page is allowed to load\n' +
        '3. Test a different page without CSP restrictions\n' +
        '4. Use individual uiux_* tools (contrast_check, color_extract, font_audit) which do not require CDN access\n\n' +
        `Error detail: ${detail}`;

      response.addCode(`// axe-core injection failed (CSP or network)`);
      response.addTextResult(JSON.stringify({
        error: 'csp_blocked',
        message,
        detail,
        axeCoreUrl: AXE_CORE_URL,
      }, null, 2));
      return;
    }

    // Run axe audit
    const results = await page.evaluate(async (scope: string | undefined) => {
      const axe = (window as any).axe;
      const options: any = {};
      if (scope)
        options.context = scope;

      const result = await axe.run(scope || document, options);
      return {
        violations: result.violations.map((v: any) => ({
          id: v.id,
          impact: v.impact,
          description: v.description,
          nodes: v.nodes.map((n: any) => ({
            html: n.html,
            target: n.target,
            failureSummary: n.failureSummary,
          })),
        })),
        passes: result.passes.length,
      };
    }, params.scope);

    response.addCode(`// Ran axe-core accessibility audit${params.scope ? ` on "${params.scope}"` : ''}`);
    response.addTextResult(JSON.stringify(results, null, 2));
  },
});

const contrastCheck = defineTabTool({
  capability: 'core',
  schema: {
    name: 'uiux_contrast_check',
    title: 'Contrast Check',
    description: 'Check color contrast ratios against WCAG AA standards',
    inputSchema: z.object({
      selector: z.string().optional().describe('CSS selector for elements to check (default: all text elements)'),
    }),
    type: 'readOnly',
  },

  handle: async (tab, params, response) => {
    const page = tab.page;

    const results = await page.evaluate((selector: string | undefined) => {
      function getRelativeLuminance(r: number, g: number, b: number): number {
        const [rs, gs, bs] = [r, g, b].map(c => {
          c = c / 255;
          return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
      }

      function contrastRatio(l1: number, l2: number): number {
        const lighter = Math.max(l1, l2);
        const darker = Math.min(l1, l2);
        return (lighter + 0.05) / (darker + 0.05);
      }

      function parseColor(color: string): { r: number; g: number; b: number; a: number } | null {
        const rgba = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
        if (rgba) {
          return {
            r: parseInt(rgba[1], 10),
            g: parseInt(rgba[2], 10),
            b: parseInt(rgba[3], 10),
            a: rgba[4] ? parseFloat(rgba[4]) : 1,
          };
        }
        return null;
      }

      function getEffectiveBackground(el: Element): { r: number; g: number; b: number } {
        let current: Element | null = el;
        const backgrounds: { r: number; g: number; b: number; a: number }[] = [];

        while (current) {
          const style = window.getComputedStyle(current);
          const bgColor = parseColor(style.backgroundColor);
          if (bgColor && bgColor.a > 0) {
            backgrounds.unshift(bgColor);
          }
          current = current.parentElement;
        }

        // Start with white background
        let result = { r: 255, g: 255, b: 255 };
        for (const bg of backgrounds) {
          result = {
            r: Math.round(result.r * (1 - bg.a) + bg.r * bg.a),
            g: Math.round(result.g * (1 - bg.a) + bg.g * bg.a),
            b: Math.round(result.b * (1 - bg.a) + bg.b * bg.a),
          };
        }
        return result;
      }

      function getUniqueSelector(el: Element): string {
        if (el.id) return `#${el.id}`;
        const tag = el.tagName.toLowerCase();
        const classes = Array.from(el.classList).slice(0, 2).join('.');
        return classes ? `${tag}.${classes}` : tag;
      }

      const defaultSelector = 'p, h1, h2, h3, h4, h5, h6, span, a, li, td, th, label, button';
      const elements = document.querySelectorAll(selector || defaultSelector);
      const results: Array<{
        selector: string;
        ratio: number;
        wcagLevel: string;
        pass: boolean;
        text: string;
      }> = [];

      let passCount = 0;
      let failCount = 0;

      elements.forEach((el) => {
        const text = el.textContent?.trim();
        if (!text) return;

        const style = window.getComputedStyle(el);
        const textColor = parseColor(style.color);
        if (!textColor) return;

        const bgColor = getEffectiveBackground(el);
        const textLum = getRelativeLuminance(textColor.r, textColor.g, textColor.b);
        const bgLum = getRelativeLuminance(bgColor.r, bgColor.g, bgColor.b);
        const ratio = contrastRatio(textLum, bgLum);

        const fontSize = parseFloat(style.fontSize);
        const fontWeight = parseInt(style.fontWeight, 10) || 400;
        const isLargeText = fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700);

        const requiredRatio = isLargeText ? 3 : 4.5;
        const pass = ratio >= requiredRatio;
        const wcagLevel = ratio >= 7 ? 'AAA' : ratio >= 4.5 ? 'AA' : ratio >= 3 ? 'AA-large' : 'fail';

        if (pass) passCount++;
        else failCount++;

        results.push({
          selector: getUniqueSelector(el),
          ratio: Math.round(ratio * 100) / 100,
          wcagLevel,
          pass,
          text: text.slice(0, 50),
        });
      });

      return {
        elements: results.slice(0, 50), // Limit output
        summary: { pass: passCount, fail: failCount },
      };
    }, params.selector);

    response.addCode(`// Checked contrast ratios${params.selector ? ` for "${params.selector}"` : ''}`);
    response.addTextResult(JSON.stringify(results, null, 2));
  },
});

const touchTargets = defineTabTool({
  capability: 'core',
  schema: {
    name: 'uiux_touch_targets',
    title: 'Touch target size audit',
    description: 'Audit interactive elements against WCAG 2.5.5 (AA: 44px) and 2.5.8 (AAA 2.2: 24px) target size requirements. Does not check spacing between adjacent targets.',
    inputSchema: z.object({
      minSize: z.number().optional().describe('Minimum touch target size in px. WCAG 2.5.5 Level AA requires 44. Defaults to 44.'),
      innerTargetSize: z.number().optional().describe('Inner target size in px. WCAG 2.5.8 Level AAA (2.2) requires 24. Defaults to 24.'),
      excludeSelector: z.string().optional().describe('CSS selector for elements to exclude from audit'),
    }),
    type: 'readOnly',
  },

  handle: async (tab, params, response) => {
    const minSize = params.minSize ?? 44;
    const innerTargetSize = params.innerTargetSize ?? 24;
    const excludeSelector = params.excludeSelector;

    const result = await tab.page.evaluate(({ min, inner, exclude }: { min: number; inner: number; exclude: string | undefined }) => {
      const interactiveSelector = 'button, a, input:not([type="hidden"]), select, textarea, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="radio"], [tabindex]:not([tabindex="-1"])';
      const candidates = Array.from(document.querySelectorAll(interactiveSelector));

      let excludeSet: Set<Element> = new Set();
      if (exclude) {
        try {
          excludeSet = new Set(Array.from(document.querySelectorAll(exclude)));
        } catch (err) {
          // Invalid selector: treat as no exclusions.
        }
      }

      const getUniqueSelector = (el: Element): string => {
        if (el.id) return `#${el.id}`;
        const tag = el.tagName.toLowerCase();
        const classes = Array.from(el.classList).slice(0, 2).join('.');
        const base = classes ? `${tag}.${classes}` : tag;
        // Add parent context if available
        const parent = el.parentElement;
        if (parent && parent.tagName.toLowerCase() !== 'body') {
          const pTag = parent.tagName.toLowerCase();
          const pCls = Array.from(parent.classList).slice(0, 1).join('.');
          const pBase = pCls ? `${pTag}.${pCls}` : pTag;
          return `${pBase} > ${base}`;
        }
        return base;
      };

      const isHidden = (el: Element): boolean => {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return true;
        if (el.getAttribute('aria-hidden') === 'true') return true;
        return false;
      };

      type Failure = {
        selector: string;
        tagName: string;
        text: string;
        rect: { width: number; height: number };
        shortfall: { width: number; height: number };
        level: 'AA' | 'AAA';
      };

      const failures: Failure[] = [];
      let passCount = 0;
      let auditedCount = 0;

      for (const el of candidates) {
        if (excludeSet.has(el)) continue;
        if (isHidden(el)) continue;

        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        auditedCount++;

        const failsAA = rect.width < min || rect.height < min;
        const failsAAA = rect.width < inner || rect.height < inner;

        if (failsAAA || failsAA) {
          // Prefer the stricter-failing level for reporting
          const level: 'AA' | 'AAA' = failsAAA ? 'AAA' : 'AA';
          const threshold = failsAAA ? inner : min;
          const shortfallWidth = Math.max(0, threshold - rect.width);
          const shortfallHeight = Math.max(0, threshold - rect.height);
          const text = (el.textContent || '').trim().slice(0, 40);
          failures.push({
            selector: getUniqueSelector(el),
            tagName: el.tagName,
            text,
            rect: { width: Math.round(rect.width), height: Math.round(rect.height) },
            shortfall: { width: Math.round(shortfallWidth), height: Math.round(shortfallHeight) },
            level,
          });
        } else {
          passCount++;
        }
      }

      const failCount = failures.length;
      const complianceRate = auditedCount > 0 ? passCount / auditedCount : 1;

      return {
        totalAudited: auditedCount,
        failures,
        summary: {
          failCount,
          passCount,
          complianceRate: Math.round(complianceRate * 1000) / 1000,
        },
        thresholds: { minSize: min, innerTargetSize: inner },
        note: 'Applies WCAG 2.5.5 Level AA (44x44px) and 2.5.8 Level AAA 2.2 (24x24px). Spacing between adjacent targets is a separate concern not covered here.',
      };
    }, { min: minSize, inner: innerTargetSize, exclude: excludeSelector });

    response.addCode(`// Audited touch targets against WCAG 2.5.5 AA (${minSize}px) and 2.5.8 AAA (${innerTargetSize}px)`);
    response.addTextResult(JSON.stringify(result, null, 2));
  },
});

export default [
  accessibilityAudit,
  contrastCheck,
  touchTargets,
];
