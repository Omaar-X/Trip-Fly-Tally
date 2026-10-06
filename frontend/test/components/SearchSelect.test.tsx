import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { SearchSelect, SearchOption } from '../../src/components/ui';

const LEDGERS: SearchOption[] = [
  { value: 1, label: 'Cash in Hand', hint: 'Cash-in-Hand' },
  { value: 2, label: 'City Bank — A/C 110245', hint: 'Bank Accounts' },
  { value: 3, label: 'bKash Merchant Wallet', hint: 'Bank Accounts' },
  { value: 4, label: 'Salary Expense', hint: 'Indirect Expenses' },
];

/** Mirrors real usage: the parent owns the value. */
function Harness({ options = LEDGERS, onPick }: { options?: SearchOption[]; onPick?: (v: string) => void }) {
  const [value, setValue] = useState<string>('');
  return (
    <SearchSelect
      ariaLabel="Ledger"
      value={value}
      options={options}
      onChange={(v) => { setValue(v); onPick?.(v); }}
    />
  );
}

const openBox = async (user: ReturnType<typeof userEvent.setup>) => {
  const box = screen.getByRole('combobox', { name: 'Ledger' });
  await user.click(box);
  return box;
};

describe('SearchSelect', () => {
  it('narrows the list as you type', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const box = await openBox(user);
    expect(screen.getAllByRole('option')).toHaveLength(4);

    await user.type(box, 'cit');
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent('City Bank');
  });

  it('matches on the hint, so a group name finds its ledgers', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const box = await openBox(user);
    await user.type(box, 'bank accounts');
    expect(screen.getAllByRole('option')).toHaveLength(2);
  });

  it('picks with the keyboard alone', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    const box = await openBox(user);

    await user.type(box, 'bank');       // City Bank, bKash
    await user.keyboard('{ArrowDown}'); // move to the second
    await user.keyboard('{Enter}');

    expect(onPick).toHaveBeenCalledWith('3');
    // Closed, the field reads back as the chosen row.
    expect(box).toHaveValue('bKash Merchant Wallet');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('picks with a click', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    await openBox(user);
    await user.click(screen.getByText('Salary Expense'));
    expect(onPick).toHaveBeenCalledWith('4');
  });

  it('leaves the value untouched when Escape backs out', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    const box = await openBox(user);
    await user.type(box, 'salary');
    await user.keyboard('{Escape}');

    expect(onPick).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(box).toHaveValue('');
  });

  it('says so when nothing matches, instead of showing an empty box', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const box = await openBox(user);
    await user.type(box, 'zzz');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText(/No match/)).toBeInTheDocument();
  });

  it('caps a long list and says how much is left', async () => {
    const many: SearchOption[] = Array.from({ length: 300 }, (_, i) => ({
      value: i + 1, label: `Ledger ${i + 1}`,
    }));
    const user = userEvent.setup();
    render(<Harness options={many} />);
    await openBox(user);

    expect(screen.getAllByRole('option')).toHaveLength(50);
    expect(screen.getByText(/250 more/)).toBeInTheDocument();
  });

  it('offers a way back to nothing on an optional field', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    function Optional() {
      const [value, setValue] = useState<string>('2');
      return (
        <SearchSelect
          ariaLabel="Supplier" emptyLabel="None" options={LEDGERS}
          value={value} onChange={(v) => { setValue(v); onPick(v); }}
        />
      );
    }
    render(<Optional />);
    const box = screen.getByRole('combobox', { name: 'Supplier' });
    expect(box).toHaveValue('City Bank — A/C 110245');

    await user.click(box);
    await user.click(screen.getByText('None'));
    expect(onPick).toHaveBeenCalledWith('');
    expect(box).toHaveValue('None');
  });

  it('does not swallow Enter when there is nothing to take', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(<form onSubmit={onSubmit}><Harness options={[]} /></form>);
    const box = await openBox(user);
    await user.type(box, '{Enter}');
    expect(onSubmit).toHaveBeenCalled();
  });
});
