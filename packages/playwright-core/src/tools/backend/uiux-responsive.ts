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

function dateAsFileName(prefix: string, extension: string, date?: Date): string {
  date = date ?? new Date();
  return `${prefix}-${date.toISOString().replace(/[:.]/g, '-')}.${extension}`;
}

const DEFAULT_VIEWPORTS = [375, 768, 1024, 1440];
const DEFAULT_HEIGHT = 800;

const responsivePreview = defineTabTool({
  capability: 'vision',
  schema: {
    name: 'uiux_responsive_preview',
    title: 'Responsive Preview',
    description: 'Take screenshots at multiple viewport widths to preview responsive behavior',
    inputSchema: z.object({
      viewports: z.array(z.number()).optional().describe('Viewport widths in pixels (default: 375, 768, 1024, 1440)'),
    }),
    type: 'readOnly',
  },

  handle: async (tab, params, response) => {
    const viewports = params.viewports || DEFAULT_VIEWPORTS;
    const previews: Array<{ width: number; screenshot_path: string; viewport_height: number }> = [];

    // Store original viewport to restore later
    const originalViewport = tab.page.viewportSize();

    try {
      for (const width of viewports) {
        // Set viewport size
        await tab.page.setViewportSize({ width, height: DEFAULT_HEIGHT });

        // Wait for layout to settle
        await tab.page.waitForTimeout(100);

        // Take screenshot
        const screenshot = await tab.page.screenshot({ type: 'png', scale: 'css' });

        // Get actual viewport height after resize
        const currentViewport = tab.page.viewportSize();
        const viewportHeight = currentViewport?.height || DEFAULT_HEIGHT;

        // Generate filename
        const filename = dateAsFileName(`responsive-${width}w`, 'png');

        // Add to response
        await response.addResult(
          `Viewport ${width}px`,
          screenshot,
          { prefix: `responsive-${width}w`, ext: 'png', suggestedFilename: filename, contentType: 'image/png' }
        );

        previews.push({
          width,
          screenshot_path: filename,
          viewport_height: viewportHeight,
        });

        response.addCode(`// Screenshot at ${width}px viewport`);
        response.addCode(`await page.setViewportSize({ width: ${width}, height: ${DEFAULT_HEIGHT} });`);
        response.addCode(`await page.screenshot({ path: '${filename}' });`);
      }

      // Restore original viewport
      if (originalViewport) {
        await tab.page.setViewportSize(originalViewport);
      }

      // Add summary
      response.addTextResult(JSON.stringify({ previews }, null, 2));

    } catch (error) {
      // Restore original viewport on error
      if (originalViewport) {
        await tab.page.setViewportSize(originalViewport).catch(() => {});
      }
      throw error;
    }
  },
});

export default [responsivePreview];
