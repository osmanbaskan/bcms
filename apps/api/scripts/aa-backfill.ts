import { Buffer } from 'node:buffer';
import { PrismaClient } from '@prisma/client';
import { parseNewsMlG2 } from '../src/modules/news/newsml-g2.parser.js';

// Kategorisi/gövdesi boş kalan AA item'larını (doküman çekimi o an başarısız
// olanları) dokümanı yeniden çekip doldurur. Tek seferlik backfill.
const prisma = new PrismaClient();
const U = process.env.AA_API_USER ?? '3000770';
const P = process.env.AA_API_PASS ?? '';
const auth = 'Basic ' + Buffer.from(`${U}:${P}`).toString('base64');

const items = await prisma.newsWireItem.findMany({
  where: { source: 'AA', category: null, externalId: { startsWith: 'aa:' } },
});
console.log('boş AA item:', items.length);

let fixed = 0;
for (const it of items) {
  try {
    const res = await fetch(`https://api.aa.com.tr/abone/document/${encodeURIComponent(it.externalId!)}/newsml29`, {
      headers: { Authorization: auth },
    });
    if (!res.ok) { console.log('  skip', it.externalId, 'HTTP', res.status); continue; }
    const parsed = parseNewsMlG2(await res.text())[0];
    if (!parsed) { console.log('  parse yok', it.externalId); continue; }
    await prisma.newsWireItem.update({
      where: { id: it.id },
      data: { category: parsed.category, body: parsed.body, priority: parsed.priority },
    });
    console.log('  ✓', it.externalId, '→', parsed.category);
    fixed += 1;
  } catch (e) {
    console.log('  hata', it.externalId, (e as Error).message);
  }
}
console.log('düzeltilen:', fixed);
await prisma.$disconnect();
