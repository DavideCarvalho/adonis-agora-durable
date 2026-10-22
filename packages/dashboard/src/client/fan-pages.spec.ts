import { describe, expect, it } from 'vitest';
import { fanPagesInView } from './fan-pages.js';

describe('fanPagesInView', () => {
  it('asks for the first page while nothing is in view, to learn the total', () => {
    expect(fanPagesInView(undefined, undefined)).toEqual([0]);
  });

  it('fetches only the page the visible rows sit on', () => {
    expect(fanPagesInView(0, 20)).toEqual([0]);
    expect(fanPagesInView(23_410, 23_440)).toEqual([234]);
  });

  it('fetches both pages when the view straddles a boundary', () => {
    expect(fanPagesInView(90, 110)).toEqual([0, 1]);
  });

  it('honours a custom page size', () => {
    expect(fanPagesInView(10, 25, 10)).toEqual([1, 2]);
  });
});
