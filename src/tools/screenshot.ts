/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {zod} from '../third_party/index.js';
import type {ElementHandle, Page} from '../third_party/index.js';

import {ToolCategory} from './categories.js';
import {definePageTool} from './ToolDefinition.js';

const DEFAULT_FORMAT = 'jpeg';
const DEFAULT_QUALITY = 60;
const MAX_INLINE_SIZE = 100_000; // 100KB

export const screenshot = definePageTool({
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
      .describe('Type of format to save the screenshot as. Default is "jpeg"'),
    quality: zod
      .number()
      .min(0)
      .max(100)
      .optional()
      .describe(
        `Compression quality for JPEG and WebP formats (0-100). Higher values mean better quality but larger file sizes. Ignored for PNG format. Default is ${DEFAULT_QUALITY}.`,
      ),
    uid: zod
      .string()
      .optional()
      .describe(
        'The uid of an element on the page from the page content snapshot. If omitted, takes a page screenshot.',
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
  blockedByDialog: true,
  handler: async (request, response, context) => {
    context.validatePath(request.params.filePath);
    if (request.params.uid && request.params.fullPage) {
      throw new Error('Providing both "uid" and "fullPage" is not allowed.');
    }

    let pageOrHandle: Page | ElementHandle;
    if (request.params.uid) {
      pageOrHandle = await request.page.getElementByUid(request.params.uid);
    } else {
      pageOrHandle = request.page.pptrPage;
    }

    const format = request.params.format;
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

    const sizeKB = Math.round(screenshot.length / 1024);
    response.appendResponseLine(`Screenshot size: ${sizeKB}KB (${format}, quality: ${quality ?? 'lossless'})`);

    if (request.params.filePath) {
      const result = await context.saveFile(
        screenshot,
        request.params.filePath,
        `.${format}`,
      );
      response.appendResponseLine(`Saved screenshot to ${result.filename}.`);
    } else if (screenshot.length >= MAX_INLINE_SIZE) {
      const {filepath} = await context.saveTemporaryFile(
        screenshot,
        `screenshot.${request.params.format}`,
      );
      response.appendResponseLine(`Screenshot too large for inline (>${Math.round(MAX_INLINE_SIZE/1024)}KB). Saved to ${filepath}.`);
    } else {
      const extension = request.params.format === 'jpeg' ? 'jpg' : request.params.format;
      response.attachImage({
        mimeType: `image/${request.params.format}`,
        data: Buffer.from(screenshot).toString('base64'),
        fileName: `screenshot.${extension}`,
      });
    }
  },
});
