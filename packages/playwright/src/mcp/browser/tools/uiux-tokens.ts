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

const cssVariables = defineTabTool({
  capability: 'core',
  schema: {
    name: 'uiux_css_variables',
    title: 'Extract CSS custom properties',
    description: 'Enumerates CSS custom properties (design tokens), their defining selectors, and detects unused/undefined var() references',
    inputSchema: z.object({
      onlyRootScope: z.boolean().optional().describe('Only include variables defined at :root / html scope. Defaults to false.'),
      includeUsageAnalysis: z.boolean().optional().describe('Scan computed styles and stylesheet rules for var() references to detect unused tokens. Defaults to true.'),
    }),
    type: 'readOnly',
  },

  handle: async (tab, params, response) => {
    const onlyRootScope = params.onlyRootScope ?? false;
    const includeUsageAnalysis = params.includeUsageAnalysis ?? true;

    const result = await tab.page.evaluate(({ onlyRoot, includeUsage }: { onlyRoot: boolean; includeUsage: boolean }) => {
      type Token = { name: string; value: string; selector: string; source: string };
      const tokens: Token[] = [];
      const skippedStylesheets: string[] = [];
      const referencedNames = new Set<string>();
      const varReferenceRegex = /var\(\s*(--[A-Za-z0-9_-]+)/g;

      const isRootSelector = (sel: string): boolean => {
        const normalized = sel.trim().toLowerCase();
        return normalized === ':root' || normalized === 'html' || normalized === 'html:root' || normalized === ':root, html' || normalized === 'html, :root';
      };

      const sheets = Array.from(document.styleSheets);
      for (const sheet of sheets) {
        let rules: CSSRuleList;
        try {
          rules = sheet.cssRules;
        } catch (err) {
          skippedStylesheets.push(sheet.href || 'inline');
          continue;
        }
        const sourceLabel = sheet.href || 'inline';
        const walkRules = (rulesList: CSSRuleList) => {
          for (let i = 0; i < rulesList.length; i++) {
            const rule = rulesList[i];
            // Collect var() references from ALL rule cssText
            if (includeUsage && rule.cssText) {
              let match: RegExpExecArray | null;
              varReferenceRegex.lastIndex = 0;
              while ((match = varReferenceRegex.exec(rule.cssText)) !== null)
                referencedNames.add(match[1]);
            }
            if (rule instanceof CSSStyleRule) {
              const selText = rule.selectorText;
              if (onlyRoot && !isRootSelector(selText))
                continue;
              const style = rule.style;
              for (let j = 0; j < style.length; j++) {
                const propName = style.item(j);
                if (propName.startsWith('--')) {
                  tokens.push({
                    name: propName,
                    value: style.getPropertyValue(propName).trim(),
                    selector: selText,
                    source: sourceLabel,
                  });
                }
              }
            } else if (rule instanceof CSSMediaRule || rule instanceof CSSSupportsRule) {
              walkRules(rule.cssRules);
            }
          }
        };
        walkRules(rules);
      }

      // Collect var() refs from inline style attributes
      if (includeUsage) {
        const allEls = document.querySelectorAll('*');
        allEls.forEach(el => {
          const inline = el.getAttribute('style');
          if (!inline) return;
          let match: RegExpExecArray | null;
          varReferenceRegex.lastIndex = 0;
          while ((match = varReferenceRegex.exec(inline)) !== null)
            referencedNames.add(match[1]);
        });
      }

      // Deduplicate token definitions by (name, selector, source); keep first occurrence
      const definedNames = new Set<string>(tokens.map(t => t.name));

      let unusedTokens: string[] = [];
      let undefinedReferenced: string[] = [];
      if (includeUsage) {
        unusedTokens = Array.from(definedNames).filter(n => !referencedNames.has(n)).sort();
        undefinedReferenced = Array.from(referencedNames).filter(n => !definedNames.has(n)).sort();
      }

      const output: {
        tokens: Token[];
        totalDefined: number;
        totalUsed: number;
        unusedTokens?: string[];
        undefinedReferenced?: string[];
        skippedStylesheets: string[];
      } = {
        tokens,
        totalDefined: definedNames.size,
        totalUsed: includeUsage ? (definedNames.size - unusedTokens.length) : 0,
        skippedStylesheets,
      };
      if (includeUsage) {
        output.unusedTokens = unusedTokens;
        output.undefinedReferenced = undefinedReferenced;
      }
      return output;
    }, { onlyRoot: onlyRootScope, includeUsage: includeUsageAnalysis });

    response.addCode(`// Extracted ${result.totalDefined} CSS custom properties${onlyRootScope ? ' (root scope only)' : ''}`);
    response.addTextResult(JSON.stringify(result, null, 2));
  },
});

export default [cssVariables];
