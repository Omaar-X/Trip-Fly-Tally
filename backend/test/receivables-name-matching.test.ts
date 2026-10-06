import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';
import { ROLE } from '../src/constants/roles';
import { authHeader } from './helpers/token';
import {
  SIMILARITY_THRESHOLD, canonicalMap, clusterNames, differsOnlyByCode,
  levenshtein, normaliseName, similarity,
} from '../src/modules/salesFiles/nameMatching';

/**
 * Every name below is one the office actually typed into these workbooks. The
 * interesting cases are not the obvious typos — they are the two pairs that
 * look alike and must not be merged, and the pair that looks different and
 * must be.
 */

const w = (name: string, rows = 1, amount = 0) => ({ name, rows, amount });

describe('edit distance', () => {
  it('measures what it says it measures', () => {
    expect(levenshtein('', '')).toBe(0);
    expect(levenshtein('ECO', 'ECO')).toBe(0);
    expect(levenshtein('', 'ECO')).toBe(3);
    expect(levenshtein('SORCING', 'SORCHING')).toBe(1);
    expect(similarity('SORCING', 'SORCHING')).toBeCloseTo(1 - 1 / 8, 5);
    expect(similarity('', '')).toBe(1);
  });

  it('is symmetric', () => {
    expect(similarity('DESIGHNER FASHION', 'DESIGNED FASHION'))
      .toBe(similarity('DESIGNED FASHION', 'DESIGHNER FASHION'));
  });
});

describe('normalisation', () => {
  it('treats case and spacing as typing accidents, not differences', () => {
    expect(normaliseName('  eco   sorching ')).toBe('ECO SORCHING');
    expect(similarity(normaliseName('Mosaib bhai'), normaliseName('MOSAIB BHAI'))).toBe(1);
  });
});

describe('clustering the real spellings', () => {
  const clusters = clusterNames([
    w('DESIGHNER FASHION', 27), w('DESIGNER FASHION', 6),
    w('DESIGNER FASHIN', 2), w('DESIGNED FASHION', 6),
    w('ECO SOURCING', 37), w('ECO SORCHING', 41), w('ECO SORCING', 19),
    w('GROUPO SORCING', 9), w('GROUPO SORCHING', 14), w('GROUP SORCHING', 2),
    w('EVEREST TURKEYS-EK', 65), w('EVEREST TURKEYS-TK', 33),
    w('EVEREST TURK-EK', 27), w('EVEREST TURK-TK', 53),
    w('SUN PHARMA', 40), w('SUN PHARMA BUD', 20), w('SUN PHARMA-LISBON', 15),
    w('EASY FASHION', 126), w('EASY FASSION', 3),
    w('RAJIB SIR', 5), w('RAZIB SIR', 2),
  ]);

  const of = (name: string) =>
    clusters.find((c) => c.variants.includes(name))!;

  it('folds a name spelled four ways into one', () => {
    expect(of('DESIGNED FASHION').variants.sort()).toEqual([
      'DESIGHNER FASHION', 'DESIGNED FASHION', 'DESIGNER FASHIN', 'DESIGNER FASHION',
    ]);
  });

  it('names a group after the spelling the office used most', () => {
    expect(of('ECO SOURCING').canonical).toBe('ECO SORCHING');   // 41 rows beats 37
    expect(of('EASY FASSION').canonical).toBe('EASY FASHION');
  });

  it('keeps ECO SORCHING and GROUPO SORCHING apart — they are two parties', () => {
    // 80% alike. CLIENT_DECISIONS §1 says this call belongs to a human, and
    // the threshold has to leave it to one.
    expect(similarity('ECO SORCHING', 'GROUPO SORCHING')).toBeLessThan(SIMILARITY_THRESHOLD);
    expect(of('ECO SORCHING').canonical).not.toBe(of('GROUPO SORCHING').canonical);
  });

  it('refuses to merge an airline code with another airline code', () => {
    // 94% alike by edit distance, and completely different things: EK is
    // Emirates, TK is Turkish. This is the merge a bare threshold gets wrong.
    expect(similarity('EVEREST TURKEYS-EK', 'EVEREST TURKEYS-TK'))
      .toBeGreaterThan(SIMILARITY_THRESHOLD);
    expect(of('EVEREST TURKEYS-EK').canonical).not.toBe(of('EVEREST TURKEYS-TK').canonical);
    expect(of('EVEREST TURK-EK').canonical).not.toBe(of('EVEREST TURK-TK').canonical);
  });

  it('still merges when the trailing token is the same word', () => {
    // The guard is about a differing short code, not about short words.
    expect(of('RAJIB SIR').canonical).toBe(of('RAZIB SIR').canonical);
  });

  it('leaves SUN PHARMA, SUN PHARMA BUD and SUN PHARMA-LISBON as three', () => {
    const names = ['SUN PHARMA', 'SUN PHARMA BUD', 'SUN PHARMA-LISBON'];
    const canonicals = new Set(names.map((n) => of(n).canonical));
    expect(canonicals.size).toBe(3);
  });

  it('links a chain: two names too far apart join through a third', () => {
    // ECO SOURCING and ECO SORCHING are 83% alike — under the threshold, so
    // they never pair up directly. ECO SORCING sits between them at 92% to
    // each, and single-link clustering is what puts all three together. This
    // is the behaviour the whole approach rests on, so it is asserted from
    // both ends: without the middle spelling they must stay apart.
    expect(similarity('ECO SOURCING', 'ECO SORCHING')).toBeLessThan(SIMILARITY_THRESHOLD);

    const pair = canonicalMap([w('ECO SOURCING', 37), w('ECO SORCHING', 41)]);
    expect(pair.get('ECO SOURCING')).toBe('ECO SOURCING');
    expect(pair.get('ECO SORCHING')).toBe('ECO SORCHING');

    const chain = canonicalMap([
      w('ECO SOURCING', 37), w('ECO SORCHING', 41), w('ECO SORCING', 19)]);
    expect(chain.get('ECO SOURCING')).toBe('ECO SORCHING');
    expect(chain.get('ECO SORCING')).toBe('ECO SORCHING');
    expect(chain.get('ECO SORCHING')).toBe('ECO SORCHING');
  });
});

describe('the trailing-code guard', () => {
  it('fires only on a differing short trailing token', () => {
    expect(differsOnlyByCode('EVEREST TURKEYS-EK', 'EVEREST TURKEYS-TK')).toBe(true);
    expect(differsOnlyByCode('EVEREST TURK-EK', 'EVEREST TURK-TK')).toBe(true);
    // Same trailing token — nothing to guard against.
    expect(differsOnlyByCode('RAJIB SIR', 'RAZIB SIR')).toBe(false);
    // The difference is a whole word, not a code.
    expect(differsOnlyByCode('ECO SORCHING', 'ECO SOURCING')).toBe(false);
    // Different shapes entirely.
    expect(differsOnlyByCode('AIR FORCE JAKY', 'AIRFORCE ZAKY')).toBe(false);
    expect(differsOnlyByCode('SUN', 'BUD')).toBe(false);
  });
});

describe('clustering is stable', () => {
  it('does not depend on the order the names arrive in', () => {
    const names = [w('ECO SORCHING', 41), w('ECO SOURCING', 37), w('ECO SORCING', 19)];
    const forward = clusterNames(names).map((c) => c.canonical);
    const backward = clusterNames([...names].reverse()).map((c) => c.canonical);
    expect(forward).toEqual(backward);
  });

  it('gives a lone name a cluster of its own', () => {
    const clusters = clusterNames([w('ZAS CORPORATION', 4)]);
    expect(clusters).toEqual([
      { canonical: 'ZAS CORPORATION', variants: ['ZAS CORPORATION'] },
    ]);
  });

  it('ignores blank names rather than clustering them together', () => {
    expect(clusterNames([w('   ', 1), w('ECO SORCHING', 2)])).toHaveLength(1);
  });
});

describe('receivables RBAC boundary', () => {
  it('rejects unauthenticated requests', async () => {
    expect((await request(app).get('/api/sales-files/receivables')).status).toBe(401);
  });

  it('keeps SALES and HR out', async () => {
    for (const role of [ROLE.SALES, ROLE.HR] as const) {
      expect((await request(app).get('/api/sales-files/receivables').set(authHeader(role))).status)
        .toBe(403);
      expect((await request(app).get('/api/sales-files/receivables/name-groups')
        .set(authHeader(role))).status).toBe(403);
    }
  });

  it('does not read "receivables" as a sales-file id', async () => {
    // `/receivables` is registered before `/:id/...`; a regression here would
    // show up as a 404 or a cast error rather than a 403.
    const res = await request(app).get('/api/sales-files/receivables').set(authHeader(ROLE.SALES));
    expect(res.status).toBe(403);
  });
});
