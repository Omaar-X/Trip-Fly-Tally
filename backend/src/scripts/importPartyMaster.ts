/**
 * Load the historical Customer/Vendor master into the books.
 *
 * Phase 2 creates the *parties* and nothing else. No invoice, no payment, no
 * voucher — those wait for Phase 3, and a master that exists first is what
 * lets them post against real ledgers instead of inventing one per spelling.
 *
 * The input is database/import/party_master.json, produced by
 * scripts/extract_party_master.py from the authoritative monthly sales
 * registers and the client's canonical-name rulings.
 *
 * Everything runs through crmService, so each party gets its receivable or
 * payable sub-ledger exactly as it would if someone typed it into the CRM
 * page. Writing rows straight into `customers` would leave every one of them
 * without a ledger, and the first invoice would fail.
 *
 *     npm --prefix backend run import:parties -- --dry-run
 *     npm --prefix backend run import:parties
 *
 * Idempotent: a party that already exists is reported as skipped, never
 * duplicated, because createCustomer/createSupplier reject a name that
 * matches one on file (see migration 008).
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { crmService } from '../modules/crm/crm.service';
import { pool } from '../config/db';

interface MasterParty {
  name: string;
  rows: number;
  phone?: string | null;
  aliases: string[];
  periods: string[];
}

interface PartyMaster {
  customers: MasterParty[];
  suppliers: MasterParty[];
  agents: { name: string; rows: number }[];
  review_required: {
    unrecognised_agency_values: { value: string; rows: number }[];
    missing_source_sheets: string[];
  };
}

interface Outcome {
  created: string[];
  skipped: { name: string; reason: string }[];
  failed: { name: string; reason: string }[];
}

const DEFAULT_FILE = resolve(__dirname, '../../../database/import/party_master.json');

const summarise = (label: string, o: Outcome) => {
  console.log(`\n${label}`);
  console.log(`  created ${o.created.length}   already on file ${o.skipped.length}   failed ${o.failed.length}`);
  for (const f of o.failed) console.log(`  FAILED  ${f.name} — ${f.reason}`);
};

async function importParties(
  companyId: number,
  parties: MasterParty[],
  kind: 'customer' | 'supplier',
  dryRun: boolean,
): Promise<Outcome> {
  const out: Outcome = { created: [], skipped: [], failed: [] };

  for (const party of parties) {
    const existing = kind === 'customer'
      ? await crmService.findCustomerByName(companyId, party.name)
      : await crmService.findSupplierByName(companyId, party.name);

    if (existing) {
      out.skipped.push({ name: party.name, reason: `already #${existing.id}` });
      continue;
    }
    if (dryRun) { out.created.push(party.name); continue; }

    try {
      if (kind === 'customer') {
        await crmService.createCustomer(companyId, {
          name: party.name,
          phone: party.phone ?? undefined,
          // Credit limits are a commercial decision the spreadsheets never
          // recorded. Zero here means "unset", not "no credit".
          creditLimit: 0,
        });
      } else {
        await crmService.createSupplier(companyId, {
          name: party.name,
          phone: party.phone ?? undefined,
        });
      }
      out.created.push(party.name);
    } catch (err) {
      out.failed.push({ name: party.name, reason: (err as Error).message });
    }
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const fileArg = args.find((a) => a.startsWith('--file='));
  const companyArg = args.find((a) => a.startsWith('--company='));

  const file = fileArg ? fileArg.slice('--file='.length) : DEFAULT_FILE;
  const companyId = companyArg ? Number(companyArg.slice('--company='.length)) : 1;

  const master = JSON.parse(readFileSync(file, 'utf8')) as PartyMaster;

  console.log(`Party master: ${file}`);
  console.log(`Company ${companyId}${dryRun ? '   (dry run — nothing will be written)' : ''}`);
  console.log(`  ${master.customers.length} customers, ${master.suppliers.length} suppliers in the file`);

  const customers = await importParties(companyId, master.customers, 'customer', dryRun);
  const suppliers = await importParties(companyId, master.suppliers, 'supplier', dryRun);

  summarise('Customers', customers);
  summarise('Suppliers', suppliers);

  // Agents are people, not parties — they belong to HR, and creating them here
  // would put employees on the receivables list.
  if (master.agents.length)
    console.log(`\nAgents seen but NOT created (they belong in HR): ${
      master.agents.map((a) => `${a.name} (${a.rows})`).join(', ')}`);

  const review = master.review_required;
  if (review.unrecognised_agency_values.length || review.missing_source_sheets.length) {
    console.log('\nREVIEW_REQUIRED');
    for (const u of review.unrecognised_agency_values)
      console.log(`  unrecognised issuing agency: "${u.value}" (${u.rows} rows)`);
    for (const m of review.missing_source_sheets)
      console.log(`  source sheet not found: ${m}`);
  }

  const failures = customers.failed.length + suppliers.failed.length;
  await pool.end();
  process.exit(failures ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => { /* already closing */ });
  process.exit(1);
});
