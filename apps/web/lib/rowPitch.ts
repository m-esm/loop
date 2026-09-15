'use client';

import { useEffect, type RefObject } from 'react';

/**
 * The floor under both Home lists, read off a rendered row instead of
 * transcribed from the rules that style one.
 *
 * globals.css used to carry the row's pitch as a calc that restated
 * `.inbox-row`, `.inbox-title` and `.inbox-sub` term by term. It restated those
 * rules, it did not read them, so the row's styling lived in two places and
 * drifted apart silently: setting `.inbox-title` to 22px moved the rendered
 * pitch to 75.69px while the calc stayed at 64.89px, and both sections then
 * floored below one row at 700, 560 and 500 with every spec still green.
 *
 * A custom property shared between the row rule and the calc does not fix that.
 * A direct `.inbox-title { font-size: 22px }` override never touches the
 * variable, so the shared version passes a tidy test and fails the real one.
 * The only source that cannot drift from the row is the row, so this measures
 * one and publishes the result.
 *
 * The pitch is the box the list actually repeats at: the row's border box plus
 * the margin that separates it from the next one, which is how
 * tests/inbox-activity.spec.ts has always measured it.
 */
const PITCH_PROPERTY = '--inbox-row-measured';

/**
 * Sub pixel noise is not a change. A write feeds the observer that triggered
 * it, so republishing a value that only moved by a rounding artefact is how a
 * measure and publish pair turns into a loop. A quarter pixel is far below any
 * real row change and far above the noise a scrollbar appearing or a fractional
 * viewport produces.
 */
const EPSILON = 0.25;

function pitchOf(row: HTMLElement): number {
  const margin = parseFloat(getComputedStyle(row).marginBottom);
  return row.getBoundingClientRect().height + (Number.isFinite(margin) ? margin : 0);
}

/**
 * Measures one rendered row and publishes its pitch on the Home container.
 *
 * Both Home lists render `.inbox-row` at the same density, which is the whole
 * reason they read as one surface, so one measurement serves both floors and
 * this lives in one place rather than once per component. The anchor is any
 * element inside Home; the container it writes to is the `main` above it, which
 * is the box both sections are direct children of and therefore the nearest
 * element whose custom properties both of them inherit.
 *
 * `signal` re-runs the effect when the rendered rows change identity, so the
 * measured row is always one that is still on the page. Size changes to a row
 * that stays put are the observer's job.
 */
export function useMeasuredRowPitch(anchor: RefObject<HTMLElement | null>, signal: string): void {
  useEffect(() => {
    const node = anchor.current;
    if (!node) return;
    const home = node.closest('main');
    if (!(home instanceof HTMLElement)) return;
    const row = home.querySelector<HTMLElement>('.inbox-row');
    // No row on the page yet, so there is nothing to derive from. The published
    // property stays absent and the CSS fallback keeps the floor off zero.
    if (!row) return;
    const publish = () => {
      if (!row.isConnected) return;
      const pitch = pitchOf(row);
      // A display:none row or a torn down page measures zero, which is not a
      // floor, it is the starvation the floor exists to prevent.
      if (!(pitch > 0)) return;
      const published = parseFloat(home.style.getPropertyValue(PITCH_PROPERTY));
      // Write only on a real change. This is the loop guard: the property feeds
      // the min-height rules that size the lists, and resizing a list can
      // resize the row inside it, so an unconditional write would hand the
      // observer a fresh notification for every notification it delivered.
      if (Number.isFinite(published) && Math.abs(published - pitch) < EPSILON) return;
      home.style.setProperty(PITCH_PROPERTY, `${pitch}px`);
    };
    // Runs after the DOM is in place, so this reads the laid out box rather
    // than an unstyled one. The observer then covers everything that changes a
    // row's size later: a viewport resize, a font finishing loading, or a style
    // change to the row rules that no variable would have told us about.
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(row);
    return () => { observer.disconnect(); };
  }, [anchor, signal]);
}
