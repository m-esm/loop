import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Locator, Page } from '@playwright/test';

/** Record what was on screen when a user-flow capture was taken.
 *
 *  The metric cannot open a PNG and tell whether it is a picture of the right
 *  screen, and it must not try to do it by pixel distance: a committed blob is
 *  byte-stable per renderer (tab-badges.png is 39442 B on macOS and 33455 B on
 *  Linux), so equality tests the renderer and a drift threshold wide enough for
 *  antialiasing is also wide enough to admit a stale capture. The facts below
 *  come from the DOM, so they are identical on every host. */
export async function captureFlow(
  page: Page, name: string, options: { mask?: Locator[]; maskColor?: string } = {},
): Promise<void> {
  const file = resolve(`docs/screenshots/${name}.png`);
  await page.screenshot({ path: file, ...options });
  const facts = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    text: (document.body.innerText || '').replace(/\s+/g, ' ').trim(),
  }));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file.replace(/\.png$/, '.json'), `${JSON.stringify(facts, null, 2)}\n`);
}
