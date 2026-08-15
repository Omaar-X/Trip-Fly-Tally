import PDFDocument from 'pdfkit';
import { Response } from 'express';
import { Row } from '../../config/db';
import { companySettingsService } from '../companySettings/companySettings.service';
import { drawPdfWatermark } from '../../utils/pdfBranding';

const TEAL = '#0f766e';
const INK = '#111827';
const MUTED = '#6b7280';
const LINE = '#e5e7eb';

const bdt = (n: number) =>
  'BDT ' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Streams a print-ready A4 invoice straight into the HTTP response.
 * Layout: brand band → bill-to / meta columns → items table → totals card →
 * amount-due strip → footer. Pure vector output, prints crisply.
 */
export async function renderInvoicePdf(res: Response, invoice: Row & { items: Row[]; payments: Row[] }): Promise<void> {
  const company = await companySettingsService.get(invoice.company_id).catch((): Row => ({ name: 'Company' } as Row));

  const doc = new PDFDocument({ size: 'A4', margin: 48, bufferPages: true });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${invoice.invoice_no}.pdf"`);
  doc.pipe(res);
  drawPdfWatermark(doc, company);

  const W = doc.page.width - 96; // usable width
  const X = 48;

  // ---------- brand band ----------
  doc.rect(0, 0, doc.page.width, 110).fill(TEAL);
  doc.fill('#ffffff').font('Helvetica-Bold').fontSize(22).text(company.name ?? 'Company', X, 34);
  doc.font('Helvetica').fontSize(9).fillColor('#ccfbf1')
    .text([company.address, company.phone, company.email].filter(Boolean).join('  •  '), X, 62);
  doc.font('Helvetica-Bold').fontSize(26).fillColor('#ffffff')
    .text('INVOICE', X, 34, { width: W, align: 'right' });
  doc.font('Helvetica').fontSize(10).fillColor('#ccfbf1')
    .text(invoice.invoice_no, X, 66, { width: W, align: 'right' });

  // ---------- bill-to / meta ----------
  let y = 140;
  doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text('BILL TO', X, y);
  doc.font('Helvetica-Bold').fontSize(12).fillColor(INK).text(invoice.customer_name, X, y + 12);
  doc.font('Helvetica').fontSize(9).fillColor(MUTED);
  let cy = y + 28;
  for (const line of [invoice.customer_address, invoice.customer_phone, invoice.customer_email].filter(Boolean)) {
    doc.text(String(line), X, cy); cy += 13;
  }

  const metaX = X + W / 2;
  const meta: [string, string][] = [
    ['Invoice date', String(invoice.invoice_date ?? '')],
    ['Due date', String(invoice.due_date ?? '—')],
    ['Status', String(invoice.status)],
  ];
  if (invoice.booking_no) meta.push(['Booking ref', String(invoice.booking_no)]);
  let my = y;
  for (const [k, v] of meta) {
    doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(k, metaX, my, { width: W / 4 });
    doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(v, metaX + W / 4, my, { width: W / 4, align: 'right' });
    my += 16;
  }

  // ---------- items table ----------
  y = Math.max(cy, my) + 24;
  const col = { desc: X, qty: X + W * 0.58, rate: X + W * 0.72, amt: X + W * 0.86 };
  doc.rect(X, y, W, 22).fill('#f0fdfa');
  doc.font('Helvetica-Bold').fontSize(8).fillColor(TEAL);
  doc.text('DESCRIPTION', col.desc + 8, y + 7);
  doc.text('QTY', col.qty, y + 7, { width: W * 0.12, align: 'right' });
  doc.text('RATE', col.rate, y + 7, { width: W * 0.12, align: 'right' });
  doc.text('AMOUNT', col.amt, y + 7, { width: W * 0.14 - 8, align: 'right' });
  y += 22;

  doc.font('Helvetica').fontSize(9.5);
  for (const it of invoice.items) {
    const h = Math.max(22, doc.heightOfString(String(it.description), { width: W * 0.55 }) + 10);
    doc.fillColor(INK).text(String(it.description), col.desc + 8, y + 6, { width: W * 0.55 });
    doc.text(Number(it.quantity).toLocaleString(), col.qty, y + 6, { width: W * 0.12, align: 'right' });
    doc.text(Number(it.rate).toLocaleString('en-IN', { minimumFractionDigits: 2 }), col.rate, y + 6, { width: W * 0.12, align: 'right' });
    doc.text(Number(it.amount).toLocaleString('en-IN', { minimumFractionDigits: 2 }), col.amt, y + 6, { width: W * 0.14 - 8, align: 'right' });
    y += h;
    doc.moveTo(X, y).lineTo(X + W, y).strokeColor(LINE).lineWidth(0.5).stroke();
  }

  // ---------- totals ----------
  y += 14;
  const tX = X + W * 0.55, tW = W * 0.45;
  const totals: [string, string, boolean][] = [
    ['Subtotal', bdt(invoice.subtotal), false],
    ...(Number(invoice.discount) > 0 ? [['Discount', '− ' + bdt(invoice.discount), false] as [string, string, boolean]] : []),
    ...(Number(invoice.vat_amount) > 0
      ? [[`VAT (${Number(invoice.vat_percent)}%)`, bdt(invoice.vat_amount), false] as [string, string, boolean]] : []),
    ['Total', bdt(invoice.total), true],
    ['Paid', bdt(invoice.paid_amount), false]
  ];
  for (const [k, v, strong] of totals) {
    doc.font(strong ? 'Helvetica-Bold' : 'Helvetica').fontSize(strong ? 11 : 9.5)
      .fillColor(strong ? INK : MUTED).text(k, tX, y, { width: tW / 2 });
    doc.font(strong ? 'Helvetica-Bold' : 'Helvetica').fillColor(INK)
      .text(v, tX + tW / 2, y, { width: tW / 2, align: 'right' });
    y += strong ? 22 : 18;
  }
  const due = Number(invoice.total) - Number(invoice.paid_amount);
  doc.rect(tX, y, tW, 30).fill(due > 0 ? TEAL : '#16a34a');
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#ffffff')
    .text(due > 0 ? 'AMOUNT DUE' : 'PAID IN FULL', tX + 10, y + 9);
  doc.text(bdt(Math.max(due, 0)), tX, y + 9, { width: tW - 10, align: 'right' });

  // ---------- footer ----------
  doc.font('Helvetica').fontSize(8).fillColor(MUTED)
    .text('Thank you for travelling with us. This is a computer-generated invoice and does not require a signature.',
      X, doc.page.height - 70, { width: W, align: 'center' });

  doc.end();
}
