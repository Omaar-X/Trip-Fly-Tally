import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import type { ServerPaging } from '../components/ui';

/**
 * Fetches ONE PAGE of a list endpoint, with the sort and the search done by
 * the server.
 *
 * Every list that can outgrow a screen goes through here so the four screens
 * behave identically and none of them can drift back to filtering a truncated
 * array in the browser.
 *
 * The search is debounced: typing "tanvir" should cost one request, not six.
 */
export function useServerList<T>(
  url: string,
  filters: Record<string, string | number | undefined>,
  deps: unknown[] = []
) {
  const [rows, setRows] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(25);
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  // A new search or filter invalidates the current page number: staying on
  // page 7 of a result set that now has two pages would show an empty table.
  const filterKey = JSON.stringify(filters);
  useEffect(() => { setPage(1); }, [debouncedQ, filterKey]);

  // Out-of-order responses would otherwise let a slow early request overwrite
  // a fast later one, leaving the table showing the wrong page.
  const requestId = useRef(0);

  useEffect(() => {
    const id = ++requestId.current;
    setLoading(true);
    api.get(url, {
      params: {
        ...filters,
        page, pageSize,
        ...(debouncedQ ? { q: debouncedQ } : {}),
        ...(sort ? { sort: sort.key, order: sort.dir === 1 ? 'asc' : 'desc' } : {}),
      },
    })
      .then((r) => {
        if (id !== requestId.current) return;
        setRows(r.data.data ?? []);
        setTotal(Number(r.data.total ?? 0));
      })
      .finally(() => { if (id === requestId.current) setLoading(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, filterKey, page, pageSize, debouncedQ, sort, reloadKey, ...deps]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  const paging: ServerPaging = useMemo(() => ({
    page, pageSize, total, sort, q,
    onPage: setPage,
    onSort: setSort,
    onQ: setQ,
  }), [page, pageSize, total, sort, q]);

  return { rows, total, loading, paging, reload };
}
