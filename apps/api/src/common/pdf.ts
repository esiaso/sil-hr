import { dirname, join } from 'node:path';
import PDFDocument from 'pdfkit';
import { BRAND } from '@sil/hr-shared';

/** Self-hosted brand fonts (SIL Open Font Licence), read from the npm packages. */
const dir = (pkg: string) => join(dirname(require.resolve(`${pkg}/package.json`)), 'files');
const FONTS = {
  Body: join(dir('@fontsource/open-sans'), 'open-sans-latin-400-normal.woff'),
  'Body-Bold': join(dir('@fontsource/open-sans'), 'open-sans-latin-700-normal.woff'),
  Display: join(dir('@fontsource/montserrat'), 'montserrat-latin-700-normal.woff'),
};

/**
 * A PDF with the PeopleTrack fonts registered as Body (Open Sans, for long text),
 * Body-Bold and Display (Montserrat, for titles), and the product as its producer.
 */
export function brandPdf(options: PDFKit.PDFDocumentOptions = {}): PDFKit.PDFDocument {
  const doc = new PDFDocument({ ...options, info: { Producer: BRAND.formalName, Creator: BRAND.name, ...(options.info ?? {}) } });
  for (const [name, file] of Object.entries(FONTS)) doc.registerFont(name, file);
  doc.font('Body');
  return doc;
}

/** "Generated with PeopleTrack · Part of the SynergyOne Suite", small and grey, at the current position. */
export function brandFooter(doc: PDFKit.PDFDocument, extra?: string) {
  doc.moveDown(1.2).font('Body').fontSize(7.5).fillColor('#5b6b80').text([extra, `Generated with ${BRAND.name} · ${BRAND.endorsement}`].filter(Boolean).join('  ·  '));
  doc.fillColor('#000');
}
