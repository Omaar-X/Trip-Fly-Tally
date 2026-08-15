import { useEffect, useMemo, useState } from 'react';
import { Database, Download, HardDrive, RefreshCw, Table2 } from 'lucide-react';
import { api, apiErrorMessage } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { Badge, ErrorNote, PageHeader, Spinner } from '../../components/ui';
import { ROLE } from '../../lib/roles';

interface TableInfo {
  name: string;
  rows: number;
  sizeBytes: number;
  updatedAt: string | null;
}

interface ColumnInfo {
  name: string;
  type: string;
}

interface TableData {
  table: string;
  columns: ColumnInfo[];
  rows: Record<string, unknown>[];
  total: number;
  limit: number;
  offset: number;
}

const LIMIT = 100;

const fileSafeDate = () => new Date().toISOString().replace(/[:.]/g, '-');

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function displayValue(value: unknown) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

async function downloadBlob(url: string, filename: string) {
  const res = await api.get(url, { responseType: 'blob' });
  const blobUrl = URL.createObjectURL(new Blob([res.data]));
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(blobUrl);
}

export default function DatabaseAdmin() {
  const { user } = useAuth();
  const isCeo = user?.role === ROLE.CEO;
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [data, setData] = useState<TableData | null>(null);
  const [loadingTables, setLoadingTables] = useState(false);
  const [loadingRows, setLoadingRows] = useState(false);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const filteredTables = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return tables;
    return tables.filter((table) => table.name.toLowerCase().includes(needle));
  }, [query, tables]);

  const page = data ? Math.floor(data.offset / data.limit) + 1 : 1;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1;

  const loadTables = async () => {
    if (!isCeo) return;
    setLoadingTables(true);
    setError(null);
    try {
      const res = await api.get('/api/admin/database/tables');
      const nextTables = res.data.data as TableInfo[];
      setTables(nextTables);
      setSelected((current) => current || nextTables[0]?.name || '');
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setLoadingTables(false);
    }
  };

  useEffect(() => { loadTables(); }, [isCeo]);

  useEffect(() => {
    if (!selected || !isCeo) return;
    setLoadingRows(true);
    setError(null);
    api.get(`/api/admin/database/tables/${selected}`, { params: { limit: LIMIT, offset } })
      .then((res) => setData(res.data.data))
      .catch((err) => setError(apiErrorMessage(err)))
      .finally(() => setLoadingRows(false));
  }, [selected, offset, isCeo]);

  const chooseTable = (table: string) => {
    setSelected(table);
    setOffset(0);
  };

  if (!isCeo) {
    return (
      <div>
        <PageHeader title="Database" sub="CEO-only database access." icon={Database} />
        <div className="card p-8 text-center text-sm text-slate-500 dark:text-slate-400">
          Database access is restricted to the CEO.
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Database"
        sub="Read-only database explorer and export center."
        icon={Database}
        actions={
          <>
            <button className="btn btn-ghost" onClick={loadTables} disabled={loadingTables}>
              <RefreshCw className={`h-4 w-4 ${loadingTables ? 'animate-spin' : ''}`} /> Refresh
            </button>
            <button
              className="btn btn-primary"
              onClick={() => downloadBlob('/api/admin/database/export.json', `erp-backup-${fileSafeDate()}.json`)}
            >
              <Download className="h-4 w-4" /> Full backup
            </button>
          </>
        }
      />

      <ErrorNote message={error} />

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[320px_minmax(0,1fr)]">
        <aside className="card overflow-hidden">
          <div className="border-b border-slate-100 bg-slate-50/70 p-3 dark:border-slate-800 dark:bg-slate-800/30">
            <input
              className="input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search tables"
            />
          </div>
          <div className="max-h-[calc(100vh-240px)] overflow-y-auto p-2">
            {loadingTables ? (
              <div className="flex h-32 items-center justify-center"><Spinner /></div>
            ) : filteredTables.map((table) => (
              <button
                key={table.name}
                onClick={() => chooseTable(table.name)}
                className={`mb-1 flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition ${
                  selected === table.name
                    ? 'bg-brand-50 text-brand-800 ring-1 ring-brand-200 dark:bg-brand-950/40 dark:text-brand-200 dark:ring-brand-800'
                    : 'hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
              >
                <Table2 className="h-4 w-4 flex-shrink-0 text-brand-600 dark:text-brand-400" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{table.name}</span>
                <span className="num text-xs text-slate-400">{table.rows}</span>
              </button>
            ))}
          </div>
        </aside>

        <section className="min-w-0">
          <div className="card overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 bg-slate-50/70 px-4 py-3 dark:border-slate-800 dark:bg-slate-800/30">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="font-bold">{selected || 'No table selected'}</h2>
                  {data && <Badge tone="teal">{data.total} rows</Badge>}
                </div>
                {selected && (
                  <div className="mt-1 flex items-center gap-2 text-xs text-slate-400">
                    <HardDrive className="h-3.5 w-3.5" />
                    {formatBytes(tables.find((t) => t.name === selected)?.sizeBytes ?? 0)}
                  </div>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  className="btn btn-ghost"
                  disabled={!selected}
                  onClick={() => downloadBlob(`/api/admin/database/tables/${selected}/export.csv`, `${selected}-${fileSafeDate()}.csv`)}
                >
                  <Download className="h-4 w-4" /> CSV
                </button>
                <button
                  className="btn btn-ghost"
                  disabled={!data || offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - LIMIT))}
                >
                  Previous
                </button>
                <span className="num rounded-lg bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-500 dark:bg-slate-800 dark:text-slate-300">
                  {page}/{pages}
                </span>
                <button
                  className="btn btn-ghost"
                  disabled={!data || offset + LIMIT >= data.total}
                  onClick={() => setOffset(offset + LIMIT)}
                >
                  Next
                </button>
              </div>
            </div>

            {loadingRows ? (
              <div className="flex h-72 items-center justify-center"><Spinner /></div>
            ) : data ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-50/80 dark:bg-slate-800/40">
                      {data.columns.map((column) => (
                        <th key={column.name} className="th text-left">
                          <span>{column.name}</span>
                          <span className="ml-1 text-[10px] font-normal text-slate-400">{column.type}</span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.length === 0 ? (
                      <tr>
                        <td className="td py-16 text-center text-slate-400" colSpan={Math.max(data.columns.length, 1)}>
                          No rows in this table.
                        </td>
                      </tr>
                    ) : data.rows.map((row, index) => (
                      <tr key={index} className="border-t border-slate-100 hover:bg-brand-50/60 dark:border-slate-800 dark:hover:bg-brand-950/25">
                        {data.columns.map((column) => (
                          <td key={column.name} className="td max-w-[280px] truncate">
                            {displayValue(row[column.name])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="p-10 text-center text-sm text-slate-400">Choose a table to preview rows.</div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
