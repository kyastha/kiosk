import { existsSync } from 'node:fs';
import PDFDocument from 'pdfkit';
import { testNotice } from './payments.js';

const dateFormat = new Intl.DateTimeFormat('en-NP', {
  timeZone: 'Asia/Kathmandu', dateStyle: 'medium', timeStyle: 'short',
});
const npr = amount => `NPR ${(amount / 100).toFixed(2)}`;

export function makePdf(config, title, rows, notice) {
  const fallbackFont = [
    '/usr/share/fonts/truetype/noto/NotoSansDevanagari-Regular.ttf',
    'C:/Windows/Fonts/Nirmala.ttf',
  ].find(existsSync);
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ size: 'A4', margin: 48, info: { Title: title } });
    const chunks = [];
    pdf.on('data', data => chunks.push(data));
    pdf.on('error', reject);
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    const font = config.receiptFont || fallbackFont;
    if (font) pdf.font(font);
    pdf.fontSize(14).fillColor('#222222').text(config.schoolName);
    pdf.moveDown(0.5).fontSize(24).text(title);
    pdf.moveDown(0.4).fontSize(12).fillColor('#742F00').text(notice);
    pdf.moveDown(1).fillColor('#222222');
    for (const [label, value] of rows) {
      pdf.fontSize(10).fillColor('#505050').text(label);
      pdf.fontSize(11).fillColor('#222222').text(String(value), { lineGap: 1 }).moveDown(0.4);
    }
    pdf.end();
  });
}

export function makeReceipt(config, order) {
  const files = order.cart_items
    ? JSON.parse(order.cart_items).map((item, index) => [
      `File ${index + 1}`,
      `${item.fileName}\nSelected pages: ${item.printablePages} (${item.pageRanges || 'all'}) | ${npr(item.total)}`,
    ])
    : [['File name', order.file_name]];
  return makePdf(config, 'Printing receipt', [
    ['Receipt number', order.receipt_number],
    ['Order ID', order.id],
    ['Customer', order.customer_name],
    ['Order time (Nepal)', dateFormat.format(order.created_at)],
    ...files,
    ['Selected pages', order.printable_pages],
    ['Copies', order.copies],
    ['Printing mode / paper', `${order.printing_mode} / ${order.paper_size}`],
    ['Price per page', npr(order.price_per_page)],
    ['Total amount', npr(order.total)],
    ['Payment reference', order.reference],
    ['Payment status', order.payment_status],
    ['Print status', {
      COMPLETED: 'COMPLETED (reported by CUPS)',
      COMPLETION_UNCONFIRMED: 'Sent to device; output unconfirmed',
    }[order.print_status] || order.print_status],
  ], testNotice);
}
