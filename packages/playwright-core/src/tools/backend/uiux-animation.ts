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

const animationAudit = defineTabTool({
  capability: 'core',
  schema: {
    name: 'uiux_animation_audit',
    title: 'Audit CSS animations and transitions',
    description: 'Finds CSS animations, transitions, and detects whether prefers-reduced-motion overrides are declared',
    inputSchema: z.object({
      includeTransitions: z.boolean().optional().describe('Include CSS transitions (not just animations). Defaults to true.'),
      onlyActive: z.boolean().optional().describe('Only report animations currently running via getAnimations(), skip declared-only scan. Defaults to false.'),
    }),
    type: 'readOnly',
  },

  handle: async (tab, params, response) => {
    const includeTransitions = params.includeTransitions ?? true;
    const onlyActive = params.onlyActive ?? false;

    const result = await tab.page.evaluate(({ includeTrans, activeOnly }: { includeTrans: boolean; activeOnly: boolean }) => {
      type ActiveAnimation = {
        selector: string;
        name: string;
        duration: number | null;
        delay: number | null;
        iterations: number | string;
        easing: string;
        fill: string;
        direction: string;
        playState: string;
      };
      type DeclaredAnimation = {
        selector: string;
        name: string;
        duration: string;
        delay: string;
        timingFunction: string;
        iterationCount: string;
        source: string;
      };
      type DeclaredTransition = {
        selector: string;
        property: string;
        duration: string;
        delay: string;
        timingFunction: string;
        source: string;
      };

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

      const skippedStylesheets: string[] = [];
      const activeAnimations: ActiveAnimation[] = [];
      const declaredAnimations: DeclaredAnimation[] = [];
      const declaredTransitions: DeclaredTransition[] = [];

      // 1. Active animations via Web Animations API
      try {
        const anims = document.getAnimations();
        for (const animation of anims) {
          const effect = animation.effect as KeyframeEffect | null;
          let selector = '(unknown)';
          if (effect && effect.target) selector = buildSelectorPath(effect.target as Element);
          const timing = effect ? effect.getTiming() : null;
          const animName = (animation as any).animationName
            || (effect && (effect as any).getKeyframes ? ((effect as any).id || '(anonymous)') : '(anonymous)');
          activeAnimations.push({
            selector,
            name: typeof animName === 'string' ? animName : '(anonymous)',
            duration: timing && typeof timing.duration === 'number' ? timing.duration : null,
            delay: timing ? (timing.delay ?? null) : null,
            iterations: timing ? (timing.iterations === Infinity ? 'infinite' : (timing.iterations ?? 1)) : 1,
            easing: timing && timing.easing ? timing.easing : 'linear',
            fill: timing && timing.fill ? timing.fill : 'none',
            direction: timing && timing.direction ? timing.direction : 'normal',
            playState: animation.playState,
          });
        }
      } catch (_err) {
        // Web Animations API may be restricted; continue with empty list
      }

      // Helper: count declared rules in cssText that reference reduced-motion-overridable props
      let totalAnimationRules = 0;
      let totalOverridesInReducedMotion = 0;

      // 2. Declared animations and transitions via stylesheet walk
      if (!activeOnly) {
        const parseAnimationShorthand = (shorthand: string): { name?: string; duration?: string; delay?: string; timingFunction?: string; iterationCount?: string } => {
          // animation shorthand is complex; attempt a lenient best-effort parse
          const tokens = shorthand.trim().split(/\s+/).filter(Boolean);
          const timeRe = /^(\d*\.?\d+)(s|ms)$/;
          const iterRe = /^(infinite|\d*\.?\d+)$/;
          const timingRe = /^(linear|ease|ease-in|ease-out|ease-in-out|step-start|step-end|cubic-bezier\(.*\)|steps\(.*\))$/;
          const out: { name?: string; duration?: string; delay?: string; timingFunction?: string; iterationCount?: string } = {};
          let seenTime = false;
          for (const t of tokens) {
            if (timeRe.test(t)) {
              if (!seenTime) { out.duration = t; seenTime = true; }
              else if (!out.delay) out.delay = t;
            } else if (timingRe.test(t)) {
              out.timingFunction = t;
            } else if (iterRe.test(t)) {
              out.iterationCount = t;
            } else if (!out.name) {
              out.name = t;
            }
          }
          return out;
        };

        const walkRules = (rulesList: CSSRuleList, sourceLabel: string, inReducedMotion: boolean) => {
          for (let i = 0; i < rulesList.length; i++) {
            const rule = rulesList[i];
            if (rule instanceof CSSStyleRule) {
              const selText = rule.selectorText;
              const style = rule.style;

              const animName = style.getPropertyValue('animation-name').trim();
              const animShorthand = style.getPropertyValue('animation').trim();
              let hasAnimation = false;
              if (animName && animName !== 'none') {
                hasAnimation = true;
                if (!inReducedMotion) {
                  declaredAnimations.push({
                    selector: selText,
                    name: animName,
                    duration: style.getPropertyValue('animation-duration').trim() || '0s',
                    delay: style.getPropertyValue('animation-delay').trim() || '0s',
                    timingFunction: style.getPropertyValue('animation-timing-function').trim() || 'ease',
                    iterationCount: style.getPropertyValue('animation-iteration-count').trim() || '1',
                    source: sourceLabel,
                  });
                }
              } else if (animShorthand && animShorthand !== 'none') {
                hasAnimation = true;
                if (!inReducedMotion) {
                  const parsed = parseAnimationShorthand(animShorthand);
                  declaredAnimations.push({
                    selector: selText,
                    name: parsed.name || '(inline)',
                    duration: parsed.duration || '0s',
                    delay: parsed.delay || '0s',
                    timingFunction: parsed.timingFunction || 'ease',
                    iterationCount: parsed.iterationCount || '1',
                    source: sourceLabel,
                  });
                }
              }

              let hasTransition = false;
              if (includeTrans) {
                const transProp = style.getPropertyValue('transition-property').trim();
                const transShorthand = style.getPropertyValue('transition').trim();
                if (transProp && transProp !== 'none' && transProp !== 'all 0s ease 0s') {
                  hasTransition = true;
                  if (!inReducedMotion) {
                    declaredTransitions.push({
                      selector: selText,
                      property: transProp,
                      duration: style.getPropertyValue('transition-duration').trim() || '0s',
                      delay: style.getPropertyValue('transition-delay').trim() || '0s',
                      timingFunction: style.getPropertyValue('transition-timing-function').trim() || 'ease',
                      source: sourceLabel,
                    });
                  }
                } else if (transShorthand && transShorthand !== 'none' && transShorthand !== 'all 0s ease 0s') {
                  hasTransition = true;
                  if (!inReducedMotion) {
                    declaredTransitions.push({
                      selector: selText,
                      property: 'all',
                      duration: '0s',
                      delay: '0s',
                      timingFunction: 'ease',
                      source: sourceLabel,
                    });
                  }
                }
              }

              if (hasAnimation || hasTransition) {
                if (inReducedMotion) {
                  totalOverridesInReducedMotion++;
                } else {
                  totalAnimationRules++;
                }
              }
            } else if (rule instanceof CSSMediaRule) {
              const mediaText = rule.media.mediaText.toLowerCase();
              const isReducedMotion = mediaText.includes('prefers-reduced-motion') && mediaText.includes('reduce');
              walkRules(rule.cssRules, sourceLabel, inReducedMotion || isReducedMotion);
            } else if (rule instanceof CSSSupportsRule) {
              walkRules(rule.cssRules, sourceLabel, inReducedMotion);
            }
          }
        };

        const sheets = Array.from(document.styleSheets);
        for (const sheet of sheets) {
          let rules: CSSRuleList;
          try {
            rules = sheet.cssRules;
          } catch (_err) {
            skippedStylesheets.push(sheet.href || 'inline');
            continue;
          }
          walkRules(rules, sheet.href || 'inline', false);
        }
      }

      // 3. Current preference
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      const currentPreference = mq.matches ? 'reduce' : 'no-preference';

      const coverage = totalAnimationRules > 0
        ? Math.min(1, totalOverridesInReducedMotion / totalAnimationRules)
        : (totalOverridesInReducedMotion > 0 ? 1 : 0);
      const uncovered = Math.max(0, totalAnimationRules - totalOverridesInReducedMotion);

      const reducedMotionSupport: {
        declaredAnimations: number;
        overriddenForReducedMotion: number;
        coverage: number;
        warning?: string;
      } = {
        declaredAnimations: totalAnimationRules,
        overriddenForReducedMotion: totalOverridesInReducedMotion,
        coverage: Math.round(coverage * 1000) / 1000,
      };
      if (uncovered > 0)
        reducedMotionSupport.warning = `${uncovered} animation/transition rule${uncovered === 1 ? '' : 's'} have no reduced-motion override`;

      const output: {
        activeAnimations: ActiveAnimation[];
        declaredAnimations?: DeclaredAnimation[];
        declaredTransitions?: DeclaredTransition[];
        reducedMotionSupport: typeof reducedMotionSupport;
        currentPreference: string;
        skippedStylesheets: string[];
      } = {
        activeAnimations,
        reducedMotionSupport,
        currentPreference,
        skippedStylesheets,
      };

      if (!activeOnly) {
        output.declaredAnimations = declaredAnimations;
        if (includeTrans) output.declaredTransitions = declaredTransitions;
      }

      return output;
    }, { includeTrans: includeTransitions, activeOnly: onlyActive });

    response.addCode(`// Audited animations: ${result.activeAnimations.length} active, ${result.reducedMotionSupport.declaredAnimations} declared`);
    response.addTextResult(JSON.stringify(result, null, 2));
  },
});

export default [animationAudit];
