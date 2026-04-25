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

type ColorEntry = {
  color: string;
  frequency: number;
  usage: string[];
};

type FontEntry = {
  family: string;
  sizes: string[];
  weights: string[];
  lineHeights: string[];
  count: number;
};

type StylesheetCoverage = {
  url: string;
  usedBytes: number;
  totalBytes: number;
  percent: number;
};

const colorExtract = defineTabTool({
  capability: 'core',

  schema: {
    name: 'uiux_color_extract',
    title: 'Extract color palette',
    description: 'Scans all elements on the page to extract colors (background, text, border) and groups them by frequency',
    inputSchema: z.object({
      includeImages: z.boolean().optional().default(false).describe('Whether to include image-based colors via canvas sampling of <img> elements and CSS background-image URLs'),
    }),
    type: 'readOnly',
  },

  handle: async (tab, params, response) => {
    const extracted = await tab.page.evaluate(async (includeImages: boolean) => {
      const colorMap = new Map<string, { frequency: number; usage: Set<string> }>();

      const addColor = (value: string, usageType: string) => {
        if (!value || value === 'rgba(0, 0, 0, 0)' || value === 'transparent')
          return;
        const existing = colorMap.get(value);
        if (existing) {
          existing.frequency++;
          existing.usage.add(usageType);
        } else {
          colorMap.set(value, { frequency: 1, usage: new Set([usageType]) });
        }
      };

      document.querySelectorAll('*').forEach(el => {
        const style = window.getComputedStyle(el);
        addColor(style.backgroundColor, 'background-color');
        addColor(style.color, 'color');
        addColor(style.borderTopColor, 'border-color');
        addColor(style.borderRightColor, 'border-color');
        addColor(style.borderBottomColor, 'border-color');
        addColor(style.borderLeftColor, 'border-color');
      });

      const skippedImages: string[] = [];

      if (includeImages) {
        const toRgbString = (r: number, g: number, b: number) => `rgb(${r}, ${g}, ${b})`;

        const sampleImage = (img: HTMLImageElement, usageType: string, sourceUrl: string) => {
          try {
            if (!img.complete || !img.naturalWidth || !img.naturalHeight) {
              skippedImages.push(sourceUrl);
              return;
            }
            const canvas = document.createElement('canvas');
            const maxDim = 64;
            const scale = Math.min(maxDim / img.naturalWidth, maxDim / img.naturalHeight, 1);
            canvas.width = Math.max(1, Math.floor(img.naturalWidth * scale));
            canvas.height = Math.max(1, Math.floor(img.naturalHeight * scale));
            const ctx = canvas.getContext('2d');
            if (!ctx) {
              skippedImages.push(sourceUrl);
              return;
            }
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

            const samplePoints: Array<[number, number]> = [
              [Math.floor(canvas.width / 2), Math.floor(canvas.height / 2)],
              [0, 0],
              [canvas.width - 1, 0],
              [0, canvas.height - 1],
              [canvas.width - 1, canvas.height - 1],
            ];

            for (const [x, y] of samplePoints) {
              try {
                const pixel = ctx.getImageData(x, y, 1, 1).data;
                const color = toRgbString(pixel[0], pixel[1], pixel[2]);
                addColor(color, usageType);
              } catch {
                // Individual pixel read fails (tainted canvas) - skip this image
                skippedImages.push(sourceUrl);
                return;
              }
            }
          } catch {
            skippedImages.push(sourceUrl);
          }
        };

        const loadImage = (src: string): Promise<HTMLImageElement | null> => {
          return new Promise(resolve => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => resolve(img);
            img.onerror = () => resolve(null);
            img.src = src;
          });
        };

        // Sample <img> tags
        const imgElements = Array.from(document.querySelectorAll('img')) as HTMLImageElement[];
        for (const img of imgElements) {
          const src = img.currentSrc || img.src;
          if (!src)
            continue;
          if (img.complete && img.naturalWidth > 0) {
            sampleImage(img, 'image', src);
          } else {
            const loaded = await loadImage(src);
            if (loaded)
              sampleImage(loaded, 'image', src);
            else
              skippedImages.push(src);
          }
        }

        // Sample CSS background-image URLs
        const bgImageUrls = new Set<string>();
        document.querySelectorAll('*').forEach(el => {
          const bg = window.getComputedStyle(el).backgroundImage;
          if (!bg || bg === 'none')
            return;
          const urlMatches = bg.match(/url\((['"]?)([^'")]+)\1\)/g);
          if (!urlMatches)
            return;
          for (const m of urlMatches) {
            const parsed = m.match(/url\((['"]?)([^'")]+)\1\)/);
            if (parsed && parsed[2])
              bgImageUrls.add(parsed[2]);
          }
        });

        for (const url of bgImageUrls) {
          const loaded = await loadImage(url);
          if (loaded)
            sampleImage(loaded, 'background-image', url);
          else
            skippedImages.push(url);
        }
      }

      const palette = Array.from(colorMap.entries()).map(([color, data]) => ({
        color,
        frequency: data.frequency,
        usage: Array.from(data.usage),
      }));

      return {
        palette,
        skippedImages: Array.from(new Set(skippedImages)),
      };
    }, params.includeImages ?? false);

    const palette: ColorEntry[] = extracted.palette.sort((a, b) => b.frequency - a.frequency);
    const dominant = palette.length > 0 ? palette[0].color : '';

    const result: {
      palette: ColorEntry[];
      dominant: string;
      skippedImages?: string[];
    } = {
      palette,
      dominant,
    };

    if (params.includeImages && extracted.skippedImages.length > 0)
      result.skippedImages = extracted.skippedImages;

    response.addTextResult(JSON.stringify(result, null, 2));
  },
});

const fontAudit = defineTabTool({
  capability: 'core',

  schema: {
    name: 'uiux_font_audit',
    title: 'Audit fonts',
    description: 'Scans all text elements to collect font-family, font-size, font-weight, and line-height information',
    inputSchema: z.object({}),
    type: 'readOnly',
  },

  handle: async (tab, params, response) => {
    const fontData = await tab.page.evaluate(() => {
      const fontMap = new Map<string, { sizes: Set<string>; weights: Set<string>; lineHeights: Set<string>; count: number }>();
      let totalElements = 0;

      const textSelectors = 'p, span, h1, h2, h3, h4, h5, h6, a, li, td, th, label, button, input, textarea, div, section, article';
      document.querySelectorAll(textSelectors).forEach(el => {
        const text = el.textContent?.trim();
        if (!text)
          return;

        totalElements++;
        const style = window.getComputedStyle(el);
        const family = style.fontFamily;
        const size = style.fontSize;
        const weight = style.fontWeight;
        const lineHeight = style.lineHeight;

        const existing = fontMap.get(family);
        if (existing) {
          existing.sizes.add(size);
          existing.weights.add(weight);
          if (lineHeight)
            existing.lineHeights.add(lineHeight);
          existing.count++;
        } else {
          fontMap.set(family, {
            sizes: new Set([size]),
            weights: new Set([weight]),
            lineHeights: new Set(lineHeight ? [lineHeight] : []),
            count: 1,
          });
        }
      });

      return {
        fonts: Array.from(fontMap.entries()).map(([family, data]) => ({
          family,
          sizes: Array.from(data.sizes),
          weights: Array.from(data.weights),
          lineHeights: Array.from(data.lineHeights).slice(0, 5),
          count: data.count,
        })),
        totalElements,
      };
    });

    const fonts: FontEntry[] = fontData.fonts.sort((a, b) => b.count - a.count);

    const result = {
      fonts,
      totalElements: fontData.totalElements,
    };

    response.addTextResult(JSON.stringify(result, null, 2));
  },
});

const cssCoverage = defineTabTool({
  capability: 'core',

  schema: {
    name: 'uiux_css_coverage',
    title: 'CSS coverage analysis',
    description: '\u26a0\ufe0f This tool reloads the page to measure CSS coverage. Form state, scroll position, and SPA state will be lost. Uses Playwright CSS coverage API to compare used vs unused CSS bytes across stylesheets',
    inputSchema: z.object({
      acceptReload: z.boolean().optional().describe('Must be true to acknowledge the page reload side-effect'),
    }),
    type: 'action',
  },

  handle: async (tab, params, response) => {
    if (!params.acceptReload) {
      response.addError(
          'uiux_css_coverage reloads the page to measure CSS coverage, which will destroy form state, scroll position, and any SPA state. ' +
          'To proceed, call this tool again with acceptReload: true.'
      );
      return;
    }

    await tab.page.coverage.startCSSCoverage();
    await tab.page.reload({ waitUntil: 'networkidle' });
    const coverage = await tab.page.coverage.stopCSSCoverage();

    const stylesheets: StylesheetCoverage[] = [];
    let totalUsed = 0;
    let totalBytes = 0;

    for (const entry of coverage) {
      const text = entry.text ?? '';
      const entryTotal = text.length;
      let entryUsed = 0;

      for (const range of entry.ranges)
        entryUsed += range.end - range.start;

      const percent = entryTotal > 0 ? Math.round((entryUsed / entryTotal) * 100) : 0;

      stylesheets.push({
        url: entry.url || '(inline)',
        usedBytes: entryUsed,
        totalBytes: entryTotal,
        percent,
      });

      totalUsed += entryUsed;
      totalBytes += entryTotal;
    }

    const result = {
      stylesheets,
      summary: {
        totalUsed,
        totalUnused: totalBytes - totalUsed,
      },
    };

    response.addTextResult(JSON.stringify(result, null, 2));
  },
});

export default [
  colorExtract,
  fontAudit,
  cssCoverage,
];
