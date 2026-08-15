import fs from 'fs';
import path from 'path';
import PDFDocument from 'pdfkit';

const LOGO_FALLBACK = '/branding/trip-fly-bd-logo.png';
const CONTACT_FALLBACK = {
  name: 'Trip Fly BD',
  email: 'info@tripflybd.com',
  phone: '+880 18 9880 1939',
  address: 'Banani, Dhaka, Bangladesh',
};

function assetPath(url: unknown): string | null {
  const value = typeof url === 'string' && url ? url : LOGO_FALLBACK;
  const file = path.join(process.cwd(), value.replace(/^\//, ''));
  return fs.existsSync(file) ? file : null;
}

/** Adds a subtle, non-obstructive company watermark behind PDF content. */
export function drawPdfWatermark(doc: PDFKit.PDFDocument, company: Record<string, unknown>): void {
  const logo = assetPath(company.logo_url);
  const name = String(company.name || CONTACT_FALLBACK.name);
  const email = String(company.email || CONTACT_FALLBACK.email);
  const phone = String(company.phone || CONTACT_FALLBACK.phone);
  const address = String(company.address || CONTACT_FALLBACK.address);
  const cx = doc.page.width / 2;
  const cy = doc.page.height / 2;

  doc.save();
  doc.opacity(0.075);
  if (logo) doc.image(logo, cx - 92, cy - 118, { fit: [184, 184], align: 'center', valign: 'center' });
  doc.fillColor('#0f766e').font('Helvetica-Bold').fontSize(20)
    .text(name, 48, cy + 78, { width: doc.page.width - 96, align: 'center' });
  doc.font('Helvetica').fontSize(9)
    .text(`${email}  •  ${phone}  •  ${address}`, 48, cy + 104,
      { width: doc.page.width - 96, align: 'center' });
  doc.restore();
}
