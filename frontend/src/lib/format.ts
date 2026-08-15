export const bdt = (n: number | string | null | undefined): string =>
  Number(n ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const compactBdt = (n: number): string => {
  const abs = Math.abs(n);
  if (abs >= 1e7) return (n / 1e7).toFixed(1) + ' Cr';
  if (abs >= 1e5) return (n / 1e5).toFixed(1) + ' L';
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
};

export const today = (): string => new Date().toISOString().slice(0, 10);

export const fmtDate = (d?: string | null): string => (d ? String(d).slice(0, 10) : '—');
