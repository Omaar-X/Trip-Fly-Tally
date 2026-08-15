import { PoolConnection } from 'mysql2/promise';
import { query, exec, withTransaction, Row, WriteResult } from '../../config/db';
import { ApiError } from '../../utils/ApiError';
import { round2, round3 } from '../../utils/money';
import { findLedgerId, SYSTEM_LEDGERS } from '../../utils/systemLedgers';
import { postVoucherTx } from '../accounting/accounting.service';
import { BooksPolicy, assertPostable, loadBooksPolicyTx } from '../accounting/fiscalPeriod.service';
import { financialReversalService } from '../accounting/reversal.service';
import { ListQuery, Paged, limitOffset, orderBy, paged } from '../../utils/paging';

/** Columns the movement list may be sorted by, mapped to safe SQL. */
const MOVEMENT_SORTS: Record<string, string> = {
  entry_date: 'se.entry_date',
  entry_type: 'se.entry_type',
  quantity: 'se.quantity',
  rate: 'se.rate',
  value_amount: 'se.value_amount',
  item_name: 'i.name',
  warehouse_name: 'w.name',
};

interface Movement extends Row {
  entry_type: 'IN' | 'OUT'; quantity: number; rate: number; entry_date: string;
  /** Present when many items' movements are fetched in one pass. */
  item_id?: number;
  /** What the voucher actually booked for this movement. 0 on pre-ledger rows. */
  value_amount?: number;
}

/**
 * Stock valuation engine. Movements are replayed in (entry_date, id) order:
 *  - FIFO keeps cost layers and consumes the oldest first.
 *  - Weighted Average tracks the value the LEDGER actually booked.
 *
 * The weighted-average figure deliberately uses each movement's recorded
 * `value_amount` rather than re-deriving a cost from the running average. That
 * is what keeps this report and the Stock in Hand ledger equal to the paisa:
 *
 * A reversal is booked as an exact undo — 5 units received for 500 go back out
 * for 500 — but a running-average replay would cost that same issue at
 * whatever the average had since become. After one reversal the two numbers
 * had drifted by 190.48 on a 2,400 balance: the report and the Balance Sheet
 * disagreeing about the same shelf, with the report in the wrong.
 *
 * FIFO is an alternative *view* and may legitimately differ from both; it is
 * shown beside the average, not reconciled to it.
 */
export function valueStock(movements: Movement[]) {
  // ---- FIFO ----
  const layers: { qty: number; rate: number }[] = [];
  // ---- Weighted average ----
  let waQty = 0, waValue = 0;

  for (const m of movements) {
    const qty = Number(m.quantity), rate = Number(m.rate);
    // Rows written before inventory reached the ledger carry no booked value;
    // fall back to quantity x rate so historical data still values sensibly.
    const booked = Number(m.value_amount) || round2(qty * rate);

    if (m.entry_type === 'IN') {
      layers.push({ qty, rate });
      waValue += booked;
      waQty += qty;
    } else {
      // FIFO consume
      let remaining = qty;
      while (remaining > 0 && layers.length) {
        const layer = layers[0];
        const take = Math.min(layer.qty, remaining);
        layer.qty -= take;
        remaining -= take;
        if (layer.qty <= 0) layers.shift();
      }
      waValue -= booked;
      waQty -= qty;
      if (waQty <= 0) { waQty = 0; waValue = 0; }
    }
  }
  const fifoQty = layers.reduce((s, l) => s + l.qty, 0);
  const fifoValue = layers.reduce((s, l) => s + l.qty * l.rate, 0);
  // Quantities carry 3 decimals (stock_entries.quantity is DECIMAL(12,3));
  // rounding them to 2 here reported a different quantity than the one stored.
  return {
    quantity: round3(fifoQty),
    fifo: { value: round2(fifoValue), layers: layers.map(l => ({ qty: round3(l.qty), rate: l.rate })) },
    weightedAverage: {
      value: round2(waValue),
      avgRate: waQty > 0 ? round2(waValue / waQty) : 0
    }
  };
}

// ------------------------- transactional helpers -----------------------------

async function lockItemTx(conn: PoolConnection, companyId: number, itemId: number): Promise<Row> {
  const [rows] = await conn.query<Row[]>(
    'SELECT id, name, unit FROM items WHERE company_id = ? AND id = ? FOR UPDATE',
    [companyId, itemId]);
  if (!rows.length) throw ApiError.badRequest('Item does not exist');
  return rows[0];
}

async function assertWarehouseUsableTx(
  conn: PoolConnection, companyId: number, warehouseId: number
): Promise<Row> {
  const [rows] = await conn.query<Row[]>(
    'SELECT id, name, is_active FROM warehouses WHERE company_id = ? AND id = ?',
    [companyId, warehouseId]);
  if (!rows.length) throw ApiError.notFound('Warehouse not found');
  if (!Number(rows[0].is_active))
    throw ApiError.badRequest(
      `Warehouse "${rows[0].name}" is inactive — reactivate it before moving stock`);
  return rows[0];
}

/**
 * Quantity of one item physically sitting in ONE warehouse.
 *
 * ★ The trailing FOR UPDATE is load-bearing, not decoration.
 *
 * Under MySQL's default REPEATABLE READ, a PLAIN SELECT returns the snapshot
 * taken at the transaction's first read — which here is well before the item
 * row was locked. So five concurrent issues would queue politely on the item
 * lock and then every one of them would read the SAME pre-queue stock figure
 * and pass the check: ten units on the shelf, five issues of ten accepted,
 * balance driven to minus forty. Measured, not imagined.
 *
 * A LOCKING read always sees the latest committed row instead of the snapshot,
 * so each waiter observes what the transaction before it actually did.
 */
async function stockOnHandTx(
  conn: PoolConnection, companyId: number, itemId: number, warehouseId: number
): Promise<number> {
  const [rows] = await conn.query<Row[]>(
    `SELECT COALESCE(SUM(CASE WHEN entry_type='IN' THEN quantity ELSE -quantity END), 0) AS qty
       FROM stock_entries
      WHERE company_id = ? AND item_id = ? AND warehouse_id = ?
        FOR UPDATE`,
    [companyId, itemId, warehouseId]);
  return round3(Number(rows[0]?.qty ?? 0));
}

/**
 * Weighted-average unit cost of an item across all warehouses — what one unit
 * cost us on average, which is what leaves the books when a unit leaves the
 * shelf. Derived from booked VALUE over quantity, so it agrees with the Stock
 * in Hand ledger by construction.
 *
 * Locking read for the same reason as stockOnHandTx: costing an issue against
 * a stale snapshot would book it at an average that no longer exists.
 */
async function weightedAveragePositionTx(
  conn: PoolConnection, companyId: number, itemId: number
): Promise<{ quantity: number; value: number }> {
  const [rows] = await conn.query<Row[]>(
    `SELECT COALESCE(SUM(CASE WHEN entry_type='IN' THEN quantity ELSE -quantity END), 0) AS qty,
            COALESCE(SUM(CASE WHEN entry_type='IN' THEN value_amount ELSE -value_amount END), 0) AS value
       FROM stock_entries WHERE company_id = ? AND item_id = ?
        FOR UPDATE`,
    [companyId, itemId]);

  return {
    quantity: round3(Number(rows[0]?.qty ?? 0)),
    value: round2(Number(rows[0]?.value ?? 0)),
  };
}

/**
 * Values an issue without letting a rounded unit rate create a residual.
 * `value` is the accounting truth; `unitCost` is a two-decimal display rate.
 * The final issue consumes the exact remaining value, so zero quantity can
 * never leave Stock-in-Hand at +/- one paisa after repeated average rounding.
 */
export function valueWeightedAverageIssue(
  position: { quantity: number; value: number }, issueQuantity: number
): { unitCost: number; value: number } {
  const quantity = round3(position.quantity);
  const stockValue = round2(position.value);
  const issue = round3(issueQuantity);
  if (!(quantity > 0) || !(stockValue > 0) || !(issue > 0) || issue > quantity)
    return { unitCost: 0, value: 0 };

  const value = issue === quantity
    ? stockValue
    : round2(issue * stockValue / quantity);
  return { unitCost: round2(stockValue / quantity), value };
}

/** Posts the ledger half of a stock movement. */
async function postStockVoucherTx(
  conn: PoolConnection, companyId: number, userId: number,
  m: { type: 'IN' | 'OUT'; quantity: number; value: number; date: string;
       supplierId?: number; item: Row; note?: string },
  policy: BooksPolicy
) {
  const stockLedgerId = await findLedgerId(conn, companyId, SYSTEM_LEDGERS.STOCK_IN_HAND);
  const label = `${m.quantity} ${m.item.unit} ${m.item.name}`;

  if (m.type === 'OUT') {
    const cogsId = await findLedgerId(conn, companyId, SYSTEM_LEDGERS.COGS);
    return postVoucherTx(conn, companyId, userId, {
      type: 'JOURNAL', date: m.date,
      narration: `Stock issued — ${label}${m.note ? ` (${m.note})` : ''}`,
      entries: [
        { ledgerId: cogsId, type: 'DR', amount: m.value, note: 'Cost of goods sold' },
        { ledgerId: stockLedgerId, type: 'CR', amount: m.value, note: label },
      ],
    }, { policy });
  }

  // Bought on credit from a named supplier: the payable is real, so it goes on
  // the supplier's own sub-ledger and shows up in what we owe.
  if (m.supplierId) {
    const [rows] = await conn.query<Row[]>(
      'SELECT id, name, ledger_id FROM suppliers WHERE company_id = ? AND id = ?',
      [companyId, m.supplierId]);
    if (!rows.length) throw ApiError.badRequest('Supplier does not exist');
    return postVoucherTx(conn, companyId, userId, {
      type: 'PURCHASE', date: m.date,
      narration: `Stock received from ${rows[0].name} — ${label}`,
      entries: [
        { ledgerId: stockLedgerId, type: 'DR', amount: m.value, note: label },
        { ledgerId: Number(rows[0].ledger_id), type: 'CR', amount: m.value, note: 'Payable to supplier' },
      ],
    }, { policy });
  }

  // No supplier named — an opening count, a found item, a transfer in. The
  // contra is Stock Adjustment rather than a made-up payable to nobody.
  const adjustmentId = await findLedgerId(conn, companyId, SYSTEM_LEDGERS.STOCK_ADJUSTMENT);
  return postVoucherTx(conn, companyId, userId, {
    type: 'JOURNAL', date: m.date,
    narration: `Stock received — ${label}${m.note ? ` (${m.note})` : ''}`,
    entries: [
      { ledgerId: stockLedgerId, type: 'DR', amount: m.value, note: label },
      { ledgerId: adjustmentId, type: 'CR', amount: m.value, note: 'Stock adjustment' },
    ],
  }, { policy });
}

// --------------------------- warehouse helpers -------------------------------

async function getWarehouse(companyId: number, id: number): Promise<Row> {
  const rows = await query<Row[]>(
    'SELECT * FROM warehouses WHERE company_id = ? AND id = ?', [companyId, id]);
  if (!rows.length) throw ApiError.notFound('Warehouse not found');
  return rows[0];
}

/** (company_id, name) is unique in the schema; check first for a clear 409. */
async function assertNameFree(companyId: number, name: string, exceptId?: number): Promise<void> {
  const rows = await query<Row[]>(
    'SELECT id FROM warehouses WHERE company_id = ? AND name = ?', [companyId, name]);
  const clash = rows.find(r => Number(r.id) !== exceptId);
  if (clash) throw ApiError.conflict(`A warehouse named "${name}" already exists`);
}

async function assertWarehouseUsable(companyId: number, warehouseId: number): Promise<void> {
  const warehouse = await getWarehouse(companyId, warehouseId);
  if (!Number(warehouse.is_active))
    throw ApiError.badRequest(`Warehouse "${warehouse.name}" is inactive — reactivate it before moving stock`);
}

export const inventoryService = {
  listItems: (companyId: number) =>
    query<Row[]>(
      `SELECT i.*, COALESCE(SUM(CASE WHEN se.entry_type='IN' THEN se.quantity ELSE -se.quantity END),0) AS stock_qty
         FROM items i LEFT JOIN stock_entries se ON se.item_id = i.id
        WHERE i.company_id = ?
        GROUP BY i.id ORDER BY i.name`, [companyId]),

  async createItem(companyId: number, input: {
    sku: string; name: string; category?: string; unit: string;
    purchasePrice: number; salePrice: number; reorderLevel: number;
  }) {
    const result = await exec(
      `INSERT INTO items (company_id, sku, name, category, unit, purchase_price, sale_price, reorder_level)
       VALUES (?,?,?,?,?,?,?,?)`,
      [companyId, input.sku, input.name, input.category ?? null, input.unit,
       input.purchasePrice, input.salePrice, input.reorderLevel]);
    return result.insertId;
  },

  // ---------------- warehouses ----------------
  //  Every stock movement needs a warehouse_id, so without full CRUD here the
  //  inventory module cannot be used at all.

  listWarehouses: (companyId: number) =>
    query<Row[]>(
      `SELECT w.*,
              (SELECT COUNT(*) FROM stock_entries se WHERE se.warehouse_id = w.id) AS movement_count
         FROM warehouses w
        WHERE w.company_id = ? ORDER BY w.name`, [companyId]),

  async createWarehouse(companyId: number, input: { name: string; location?: string }) {
    await assertNameFree(companyId, input.name);
    const result = await exec(
      'INSERT INTO warehouses (company_id, name, location, is_active) VALUES (?,?,?,1)',
      [companyId, input.name, input.location ?? null]);
    return { id: result.insertId, name: input.name, location: input.location ?? null, isActive: true };
  },

  async updateWarehouse(companyId: number, id: number, input: {
    name?: string; location?: string; isActive?: boolean;
  }) {
    const existing = await getWarehouse(companyId, id);
    if (input.name && input.name !== existing.name) await assertNameFree(companyId, input.name, id);

    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.name !== undefined) { sets.push('name = ?'); params.push(input.name); }
    if (input.location !== undefined) { sets.push('location = ?'); params.push(input.location); }
    if (input.isActive !== undefined) { sets.push('is_active = ?'); params.push(input.isActive ? 1 : 0); }
    if (!sets.length) throw ApiError.badRequest('Nothing to update');

    params.push(companyId, id);
    await exec(`UPDATE warehouses SET ${sets.join(', ')} WHERE company_id = ? AND id = ?`, params);
    return getWarehouse(companyId, id);
  },

  /**
   * A warehouse that has never held stock is removed outright. One that has
   * movements is deactivated instead — the stock journal is a financial record
   * and deleting its warehouse would orphan history that reports still read.
   */
  async deleteWarehouse(companyId: number, id: number) {
    await getWarehouse(companyId, id);
    const [{ movements }] = await query<Row[]>(
      'SELECT COUNT(*) AS movements FROM stock_entries WHERE warehouse_id = ?', [id]);

    if (Number(movements) > 0) {
      await exec('UPDATE warehouses SET is_active = 0 WHERE company_id = ? AND id = ?', [companyId, id]);
      return { id, deleted: false, deactivated: true, movements: Number(movements) };
    }
    await exec('DELETE FROM warehouses WHERE company_id = ? AND id = ?', [companyId, id]);
    return { id, deleted: true, deactivated: false, movements: 0 };
  },

  /**
   * Record a stock movement AND its ledger consequence, in one transaction.
   *
   *   IN  with a supplier   Dr Stock in Hand      Cr Supplier A/P     (PURCHASE)
   *   IN  without           Dr Stock in Hand      Cr Stock Adjustment (JOURNAL)
   *   OUT                   Dr Cost of Goods Sold Cr Stock in Hand    (JOURNAL)
   *
   * Stock used to be a silo: movements wrote to stock_entries and nothing
   * else, so the Balance Sheet carried no closing stock, the P&L no cost of
   * goods, and the FIFO/weighted-average valuation was a report that never
   * reached the books. In a Tally-style system stock and accounts are one
   * system, and this is the join.
   *
   * An OUT is valued at WEIGHTED-AVERAGE COST, never at whatever rate the
   * operator typed: issuing stock does not change what it cost us. The
   * computed unit cost is stored back on the row so the stock journal and the
   * voucher can never tell different stories.
   */
  async recordMovement(companyId: number, userId: number, input: {
    itemId: number; warehouseId: number; type: 'IN' | 'OUT';
    quantity: number; rate: number; date: string; supplierId?: number; note?: string;
  }) {
    const quantity = round3(input.quantity);
    if (!(quantity > 0)) throw ApiError.badRequest('Quantity must be greater than zero');

    return withTransaction(async (conn) => {
      const policy = await loadBooksPolicyTx(conn, companyId);
      assertPostable(input.date, policy, 'stock movement');

      // Locking the item serialises every movement of it. The check-then-insert
      // used to run on two separate pool connections with no transaction at
      // all, so two concurrent issues could both read the same stock on hand
      // and both pass — driving the balance negative past the very guard meant
      // to prevent it.
      const item = await lockItemTx(conn, companyId, input.itemId);
      const warehouse = await assertWarehouseUsableTx(conn, companyId, input.warehouseId);

      let unitCost = round2(input.rate);
      let value: number;
      if (input.type === 'OUT') {
        // Stock is checked IN THIS WAREHOUSE. The old check summed every
        // warehouse, so goods could be issued from a store that held none as
        // long as some other store did — leaving that warehouse negative.
        const onHand = await stockOnHandTx(conn, companyId, input.itemId, input.warehouseId);
        if (onHand < quantity)
          throw ApiError.badRequest(
            `Insufficient stock of "${item.name}" in ${warehouse.name}: ` +
            `${onHand} ${item.unit} available, ${quantity} requested`);
        const position = await weightedAveragePositionTx(conn, companyId, input.itemId);
        ({ unitCost, value } = valueWeightedAverageIssue(position, quantity));
      } else {
        value = round2(quantity * unitCost);
      }

      if (!(value > 0))
        throw ApiError.badRequest(
          input.type === 'IN'
            ? 'An incoming movement needs a rate greater than zero'
            : `"${item.name}" has no cost on record yet — receive it with a rate before issuing it`);

      const voucher = await postStockVoucherTx(
        conn, companyId, userId, { ...input, quantity, value, item }, policy);

      const [result] = await conn.query<WriteResult>(
        `INSERT INTO stock_entries (company_id, item_id, warehouse_id, supplier_id, entry_type,
                                    quantity, rate, value_amount, voucher_id, entry_date, note)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [companyId, input.itemId, input.warehouseId, input.supplierId ?? null, input.type,
         quantity, unitCost, value, voucher.voucherId, input.date, input.note ?? null]);

      return {
        id: result.insertId,
        itemId: input.itemId, warehouseId: input.warehouseId, type: input.type,
        quantity, unitCost, value,
        voucherNo: voucher.voucherNo,
      };
    });
  },

  /**
   * Undo a stock movement recorded in error.
   *
   * Both halves unwind together: the voucher is mirrored, and an opposite
   * stock entry is written at the ORIGINAL value so the valuation replay
   * returns to exactly where it stood. Nothing is deleted — the stock journal
   * is a financial record and keeps both the mistake and its correction.
   */
  async reverseMovement(companyId: number, userId: number, entryId: number,
                        options: { reason?: string; date?: string } = {}) {
    return withTransaction(async (conn) => {
      const policy = await loadBooksPolicyTx(conn, companyId);

      const [rows] = await conn.query<Row[]>(
        `SELECT se.*, i.name AS item_name, i.unit
           FROM stock_entries se JOIN items i ON i.id = se.item_id
          WHERE se.id = ? AND se.company_id = ? FOR UPDATE`, [entryId, companyId]);
      if (!rows.length) throw ApiError.notFound('Stock movement not found');
      const entry = rows[0];

      if (!entry.voucher_id)
        throw ApiError.conflict(
          'This movement predates ledger integration and has no voucher to reverse');

      const opposite: 'IN' | 'OUT' = entry.entry_type === 'IN' ? 'OUT' : 'IN';
      const quantity = round3(Number(entry.quantity));

      // Reversing a receipt takes the goods back out — only possible if they
      // are still on the shelf.
      if (opposite === 'OUT') {
        const onHand = await stockOnHandTx(
          conn, companyId, Number(entry.item_id), Number(entry.warehouse_id));
        if (onHand < quantity)
          throw ApiError.conflict(
            `Cannot reverse: only ${onHand} ${entry.unit} of "${entry.item_name}" remain, ` +
            `and this receipt brought in ${quantity}. Reverse the issues that consumed it first.`);
      }

      const reversal = await financialReversalService.reverseVoucherTx(
        conn, companyId, userId, Number(entry.voucher_id),
        { reason: options.reason ?? `Reversal of stock movement #${entryId}`,
          date: options.date, policy });

      const [result] = await conn.query<WriteResult>(
        `INSERT INTO stock_entries (company_id, item_id, warehouse_id, supplier_id, entry_type,
                                    quantity, rate, value_amount, voucher_id, entry_date, note)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [companyId, entry.item_id, entry.warehouse_id, entry.supplier_id, opposite,
         quantity, entry.rate, entry.value_amount, reversal.reversalVoucherId,
         reversal.reversalDate, `Reversal of movement #${entryId}`]);

      return {
        id: entryId,
        reversalEntryId: result.insertId,
        reversalVoucherNo: reversal.reversalVoucherNo,
        reversalDate: reversal.reversalDate,
        quantity, value: round2(Number(entry.value_amount)),
      };
    });
  },

  async movements(companyId: number, itemId: number | undefined, page: ListQuery): Promise<Paged<Row>> {
    const where = itemId ? 'se.company_id = ? AND se.item_id = ?' : 'se.company_id = ?';
    const params = itemId ? [companyId, itemId] : [companyId];

    const from = `FROM stock_entries se
         JOIN items i ON i.id = se.item_id
         JOIN warehouses w ON w.id = se.warehouse_id
         LEFT JOIN suppliers sup ON sup.id = se.supplier_id
         LEFT JOIN vouchers v ON v.id = se.voucher_id
        WHERE ${where}`;

    const [{ total }] = await query<Row[]>(`SELECT COUNT(*) AS total ${from}`, params);
    const [limit, offset] = limitOffset(page);

    const rows = await query<Row[]>(
      `SELECT se.*, i.name AS item_name, i.sku, w.name AS warehouse_name,
              sup.name AS supplier_name, v.voucher_no, v.status AS voucher_status
         ${from}
        ORDER BY ${orderBy(page, MOVEMENT_SORTS, 'se.entry_date DESC, se.id DESC')}
        LIMIT ? OFFSET ?`, [...params, limit, offset]);

    return paged(rows, page, Number(total));
  },

  /** GET valuation for one item under both methods. */
  async valuation(companyId: number, itemId: number) {
    const movements = await query<Movement[]>(
      `SELECT entry_type, quantity, rate, value_amount, entry_date FROM stock_entries
        WHERE company_id = ? AND item_id = ? ORDER BY entry_date, id`, [companyId, itemId]);
    return valueStock(movements);
  },

  /**
   * Stock report across all items, both valuation methods per item.
   *
   * TWO queries in total, not one per item. This used to loop over the item
   * list awaiting a fresh valuation query for each one: 300 items cost 213 ms
   * and the cost was strictly linear, so a catalogue of 3,000 would have spent
   * over two seconds in the database to render one page. The movements are now
   * fetched once, in the order the replay needs, and grouped in memory.
   */
  async stockReport(companyId: number) {
    const [items, movements] = await Promise.all([
      query<Row[]>(
        'SELECT id, sku, name, unit, reorder_level FROM items WHERE company_id = ? ORDER BY name',
        [companyId]),
      query<Movement[]>(
        `SELECT item_id, entry_type, quantity, rate, value_amount, entry_date
           FROM stock_entries WHERE company_id = ?
          ORDER BY item_id, entry_date, id`, [companyId]),
    ]);

    const byItem = new Map<number, Movement[]>();
    for (const m of movements) {
      const key = Number(m.item_id);
      const list = byItem.get(key);
      if (list) list.push(m);
      else byItem.set(key, [m]);
    }

    return items.map((item) => {
      const v = valueStock(byItem.get(Number(item.id)) ?? []);
      return {
        item_id: item.id, sku: item.sku, name: item.name, unit: item.unit,
        quantity: v.quantity, fifo_value: v.fifo.value,
        weighted_avg_value: v.weightedAverage.value, avg_rate: v.weightedAverage.avgRate,
        low_stock: v.quantity <= Number(item.reorder_level),
      };
    });
  }
};
