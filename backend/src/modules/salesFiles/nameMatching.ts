/**
 * ================= GROUPING SPELLINGS OF THE SAME PARTY =====================
 *
 * The office types a client's name freehand on every row, so one party arrives
 * as several spellings — `DESIGHNER FASHION`, `DESIGNER FASHION`,
 * `DESIGNED FASHION`, `DESIGNER FASHIN`. Reporting those as four customers
 * splits one debt four ways and makes the receivable table useless.
 *
 * This clusters them by edit distance: two names join when they are at least
 * `SIMILARITY_THRESHOLD` alike, and clustering is single-link, so A~B and B~C
 * puts all three together even when A and C are further apart than the
 * threshold on their own.
 *
 * ── WHAT THIS IS NOT ALLOWED TO DO ─────────────────────────────────────────
 *
 * It does not rename anybody. The output is a display grouping; the customer
 * master, its ledgers and `customers.name_key` are untouched. That is
 * deliberate, and CLIENT_DECISIONS.md §1 is why: whether two similar names are
 * one party is a judgement call, and this dataset contains a case no distance
 * function can get right.
 *
 * `EVEREST TURKEYS-EK` and `EVEREST TURKEYS-TK` are 94% alike and are NOT the
 * same thing — EK is Emirates and TK is Turkish Airlines. `ECO SORCHING` and
 * `GROUPO SORCHING` are 80% alike and are genuinely two parties, which the
 * threshold happens to separate; drop it a little and they would merge.
 *
 * So the threshold is guarded by `differsOnlyByCode()`, which refuses to merge
 * names that are identical except for a short trailing token. That is the one
 * failure mode this data actually exhibits, and it is cheaper to encode than to
 * explain away later.
 */

/** 85% alike, i.e. Levenshtein distance ≤ 15% of the longer name. */
export const SIMILARITY_THRESHOLD = 0.85;

/** Longer than this is a sentence somebody pasted, not a party name. */
const MAX_COMPARED = 120;

/** Case and stray spacing are typing accidents; they are not a difference. */
export const normaliseName = (name: string): string =>
  name.trim().replace(/\s+/g, ' ').toUpperCase().slice(0, MAX_COMPARED);

/**
 * Levenshtein distance, two rows at a time.
 *
 * The full matrix is never needed — only the previous row — which keeps this
 * O(min(m,n)) in memory across the ~16k pairs a 180-name archive produces.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/** 1 = identical, 0 = nothing in common. */
export function similarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  return longest === 0 ? 1 : 1 - levenshtein(a, b) / longest;
}

/**
 * True when two names are the same except for a short trailing token.
 *
 * `EVEREST TURKEYS-EK` / `EVEREST TURKEYS-TK` — an airline code, not a typo.
 * A trailing token that MATCHES (`RAJIB SIR` / `RAZIB SIR`) is not a difference
 * at all, so those still merge.
 */
export function differsOnlyByCode(a: string, b: string): boolean {
  const ta = a.split(/[\s-]+/).filter(Boolean);
  const tb = b.split(/[\s-]+/).filter(Boolean);
  if (ta.length !== tb.length || ta.length < 2) return false;

  for (let i = 0; i < ta.length - 1; i++) if (ta[i] !== tb[i]) return false;

  const lastA = ta[ta.length - 1];
  const lastB = tb[tb.length - 1];
  return lastA !== lastB && lastA.length <= 3 && lastB.length <= 3;
}

export interface NameWeight {
  /** The name exactly as the source wrote it. */
  name: string;
  /** How many source rows carry it — decides which spelling is canonical. */
  rows: number;
  /** Money behind it, used only to break a tie in the row count. */
  amount: number;
}

export interface NameCluster {
  /** The spelling the office used most; what the UI shows. */
  canonical: string;
  /** Every spelling in the cluster, canonical included, most-used first. */
  variants: string[];
}

/**
 * Group spellings, and name each group after its most-used spelling.
 *
 * Most-used rather than longest or first: the office's own commonest spelling
 * is the one its staff will recognise in a list. Ties go to the larger amount,
 * then alphabetically, so the answer never depends on row order.
 */
export function clusterNames(
  names: NameWeight[], threshold = SIMILARITY_THRESHOLD,
): NameCluster[] {
  const items = names.map((n) => ({ ...n, key: normaliseName(n.name) }))
    .filter((n) => n.key.length > 0);

  const parent = items.map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  };
  const union = (a: number, b: number) => {
    const ra = find(a); const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i].key; const b = items[j].key;
      // Cheap rejects first: a length gap wider than the threshold allows can
      // never clear it, and the guard is cheaper than an edit-distance matrix.
      if (Math.abs(a.length - b.length) / Math.max(a.length, b.length) > 1 - threshold) continue;
      if (differsOnlyByCode(a, b)) continue;
      if (similarity(a, b) >= threshold) union(i, j);
    }
  }

  const groups = new Map<number, typeof items>();
  items.forEach((item, i) => {
    const root = find(i);
    const bucket = groups.get(root);
    if (bucket) bucket.push(item); else groups.set(root, [item]);
  });

  return [...groups.values()].map((group) => {
    const ranked = group.slice().sort((x, y) =>
      y.rows - x.rows || y.amount - x.amount || x.name.localeCompare(y.name));
    return { canonical: ranked[0].name, variants: ranked.map((r) => r.name) };
  });
}

/** raw name → canonical name, for every spelling seen. */
export function canonicalMap(names: NameWeight[], threshold = SIMILARITY_THRESHOLD) {
  const map = new Map<string, string>();
  for (const cluster of clusterNames(names, threshold))
    for (const variant of cluster.variants) map.set(normaliseName(variant), cluster.canonical);
  return map;
}
