import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// jsdom implements no layout, so it ships no scrollIntoView. Components that
// keep a highlighted row in view call it for real in a browser; here it only
// needs to exist.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

afterEach(() => cleanup());
