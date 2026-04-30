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

const spacingAudit = defineTabTool({
  capability: 'core',
  schema: {
    name: 'uiux_spacing_audit',
    title: 'Audit spacing against a base unit grid',
    description: 'Checks margin/padding/gap computed values against a base unit (e.g., 4, 8, 16) and reports non-conforming elements',
    inputSchema: z.object({
      baseUnit: z.number().optional().describe('Spacing base unit in px (default: 8)'),
      tolerance: z.number().optional().describe('Tolerance in px when matching multiples (default: 0)'),
      sampleLimit: z.number().optional().describe('Max elements to sample (default: 500)'),
      properties: z.array(z.enum(['margin', 'padding', 'gap'])).optional().describe('Which property groups to check (default: all three)'),
    }),
    type: 'readOnly',
  },

  handle: async (tab, params, response) => {
    const baseUnit = params.baseUnit ?? 8;
    const tolerance = params.tolerance ?? 0;
    const sampleLimit = params.sampleLimit ?? 500;
    const properties = params.properties && params.properties.length > 0 ? params.properties : ['margin', 'padding', 'gap'];

    if (baseUnit <= 0) {
      response.addError('uiux_spacing_audit: baseUnit must be greater than 0');
      return;
    }

    const result = await tab.page.evaluate(
        ({ baseUnitPx, tolerancePx, limit, props }: { baseUnitPx: number; tolerancePx: number; limit: number; props: string[] }) => {
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

          const parsePx = (value: string): number | null => {
            const trimmed = value.trim();
            if (!trimmed || trimmed === 'auto' || trimmed === 'normal' || trimmed === 'none') return null;
            const m = trimmed.match(/^(-?\d*\.?\d+)px$/);
            if (!m) return null;
            return parseFloat(m[1]);
          };

          const propertyGroups: Record<string, string[]> = {
            margin: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'],
            padding: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
            gap: ['row-gap', 'column-gap'],
          };

          const checkedProps: string[] = [];
          for (const group of props) {
            const list = propertyGroups[group];
            if (list) checkedProps.push(...list);
          }

          type Violation = { property: string; value: number; expectedMultiples: [number, number] };
          type Violator = { selector: string; violations: Violation[]; violationCount: number };

          const violators: Violator[] = [];
          const violationsByProperty: Record<string, number> = {};
          const valueCounts: Map<string, { value: number; property: string; count: number }> = new Map();

          let totalChecked = 0;
          let totalViolations = 0;

          const allElements = Array.from(document.querySelectorAll('*'));
          const sampled: Element[] = [];
          for (const el of allElements) {
            if (sampled.length >= limit) break;
            if (el === document.documentElement || el === document.body) continue;
            if (isHidden(el)) continue;
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) continue;
            sampled.push(el);
          }

          for (const el of sampled) {
            const style = window.getComputedStyle(el);
            // gap is only relevant for flex/grid containers
            const displayValue = style.display;
            const isFlexOrGrid = displayValue.includes('flex') || displayValue.includes('grid');

            const violations: Violation[] = [];
            for (const prop of checkedProps) {
              if ((prop === 'row-gap' || prop === 'column-gap') && !isFlexOrGrid) continue;
              totalChecked++;
              const raw = style.getPropertyValue(prop);
              const val = parsePx(raw);
              if (val === null) continue;
              if (val === 0) continue;
              const absVal = Math.abs(val);
              const remainder = absVal % baseUnitPx;
              const dist = Math.min(remainder, baseUnitPx - remainder);
              if (dist > tolerancePx) {
                const lower = Math.floor(absVal / baseUnitPx) * baseUnitPx;
                const upper = lower + baseUnitPx;
                violations.push({
                  property: prop,
                  value: val,
                  expectedMultiples: [lower, upper],
                });
                totalViolations++;
                violationsByProperty[prop] = (violationsByProperty[prop] || 0) + 1;
                const key = `${val}::${prop}`;
                const existing = valueCounts.get(key);
                if (existing) existing.count++;
                else valueCounts.set(key, { value: val, property: prop, count: 1 });
              }
            }

            if (violations.length > 0) {
              violators.push({
                selector: buildSelectorPath(el),
                violations,
                violationCount: violations.length,
              });
            }
          }

          violators.sort((a, b) => b.violationCount - a.violationCount);

          // Aggregate violationsByProperty into higher-level groups for the summary
          const aggregated: Record<string, number> = { margin: 0, padding: 0, gap: 0 };
          for (const [prop, count] of Object.entries(violationsByProperty)) {
            if (prop.startsWith('margin')) aggregated.margin += count;
            else if (prop.startsWith('padding')) aggregated.padding += count;
            else if (prop.endsWith('gap')) aggregated.gap += count;
          }
          // Only emit keys that were requested
          const violationsByGroup: Record<string, number> = {};
          for (const group of props) {
            if (group in aggregated) violationsByGroup[group] = aggregated[group];
          }

          const mostCommonViolationValues = Array.from(valueCounts.values())
              .sort((a, b) => b.count - a.count)
              .slice(0, 10);

          const complianceRate = totalChecked > 0
            ? Math.round((1 - totalViolations / totalChecked) * 10000) / 10000
            : 1;

          return {
            baseUnit: baseUnitPx,
            tolerance: tolerancePx,
            sampleLimit: limit,
            propertiesChecked: props,
            totalChecked,
            totalViolations,
            complianceRate,
            violationsByProperty: violationsByGroup,
            mostCommonViolationValues,
            topViolators: violators.slice(0, 20),
          };
        },
        { baseUnitPx: baseUnit, tolerancePx: tolerance, limit: sampleLimit, props: properties }
    );

    response.addCode(`// Spacing audit: ${result.totalViolations}/${result.totalChecked} non-conforming (base=${baseUnit}px, tol=${tolerance}px)`);
    response.addTextResult(JSON.stringify(result, null, 2));
  },
});

export default [spacingAudit];
