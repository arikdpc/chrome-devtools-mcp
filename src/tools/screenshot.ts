/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {zod} from '../third_party/index.js';
import type {ElementHandle, Page} from '../third_party/index.js';

import {ToolCategory} from './categories.js';
import {defineTool} from './ToolDefinition.js';

// Configuration for context-friendly screenshots
const DEFAULT_FORMAT = 'jpeg';  // JPEG for better compatibility
const DEFAULT_QUALITY = 60;     // Good balance of quality vs size
const MAX_INLINE_SIZE = 100_000; // 100KB max before saving to file (was 2MB!)

export const screenshot = defineTool({
  name: 'take_screenshot',
  description: `Take a screenshot of the page or element.`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    // Not read-only due to filePath param.
    readOnlyHint: false,
  },
  schema: {
    format: zod
      .enum(['png', 'jpeg', 'webp'])
      .default(DEFAULT_FORMAT)
      .describe(`Type of format to save the screenshot as. Default is "${DEFAULT_FORMAT}" for better compression.`),
    quality: zod
      .number()
      .min(0)
      .max(100)
      .optional()
      .describe(
        `Compression quality for JPEG and WebP formats (0-100). Default is ${DEFAULT_QUALITY}. Higher values mean better quality but larger file sizes. Ignored for PNG format.`,
      ),
    uid: zod
      .string()
      .optional()
      .describe(
        'The uid of an element on the page from the page content snapshot. If omitted takes a pages screenshot.',
      ),
    fullPage: zod
      .boolean()
      .optional()
      .describe(
        'If set to true takes a screenshot of the full page instead of the currently visible viewport. Incompatible with uid.',
      ),
    filePath: zod
      .string()
      .optional()
      .describe(
        'The absolute path, or a path relative to the current working directory, to save the screenshot to instead of attaching it to the response.',
      ),
  },
  handler: async (request, response, context) => {
    if (request.params.uid && request.params.fullPage) {
      throw new Error('Providing both "uid" and "fullPage" is not allowed.');
    }

    let pageOrHandle: Page | ElementHandle;
    if (request.params.uid) {
      pageOrHandle = await context.getElementByUid(request.params.uid);
    } else {
      pageOrHandle = context.getSelectedPage();
    }

    const format = request.params.format;
    // Use default quality for jpeg/webp if not specified
    const quality = format === 'png' ? undefined : (request.params.quality ?? DEFAULT_QUALITY);

    const screenshot = await pageOrHandle.screenshot({
      type: format,
      fullPage: request.params.fullPage,
      quality,
      optimizeForSpeed: true, // Bonus: optimize encoding for speed
    });

    if (request.params.uid) {
      response.appendResponseLine(
        `Took a screenshot of node with uid "${request.params.uid}".`,
      );
    } else if (request.params.fullPage) {
      response.appendResponseLine(
        'Took a screenshot of the full current page.',
      );
    } else {
      response.appendResponseLine(
        "Took a screenshot of the current page's viewport.",
      );
    }

    // Report size for transparency
    const sizeKB = Math.round(screenshot.length / 1024);
    response.appendResponseLine(`Screenshot size: ${sizeKB}KB (${format}, quality: ${quality ?? 'lossless'})`);

    if (request.params.filePath) {
      const file = await context.saveFile(screenshot, request.params.filePath);
      response.appendResponseLine(`Saved screenshot to ${file.filename}.`);
    } else if (screenshot.length >= MAX_INLINE_SIZE) {
      // Save to file if larger than threshold to avoid bloating context
      const {filename} = await context.saveTemporaryFile(
        screenshot,
        `image/${request.params.format}`,
      );
      response.appendResponseLine(`Screenshot too large for inline (>${Math.round(MAX_INLINE_SIZE/1024)}KB). Saved to ${filename}.`);
    } else {
      response.attachImage({
        mimeType: `image/${request.params.format}`,
        data: Buffer.from(screenshot).toString('base64'),
      });
    }
  },
});
