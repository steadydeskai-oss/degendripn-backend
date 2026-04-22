// Shipping rate audit — queries Printful /shipping/rates for each product
// Usage: node audit-shipping.js
require('dotenv').config();

const API_KEY  = process.env.PRINTFUL_API_KEY;
const STORE_ID = process.env.PRINTFUL_STORE_ID;
const BASE     = 'https://api.printful.com';
const HEADERS  = {
  Authorization:   `Bearer ${API_KEY}`,
  'X-PF-Store-Id': STORE_ID,
  'Content-Type':  'application/json',
};

const LA = { address1:'1 Main St', city:'Los Angeles', state_code:'CA', country_code:'US', zip:'90001' };
const UK = { address1:'1 Oxford St', city:'London',     state_code:'',   country_code:'GB', zip:'W1D 1BS' };

// catalog variant IDs (from get-sync-variants output) — one representative per product/size group
const VARIANTS = [
  // product label,                    catalog_variant_id (from /products/variant/<id>)
  // T-shirt: S=8923, 2XL=8929
  { label: 'T-Shirt S',               id: 8923  },
  { label: 'T-Shirt 2XL',             id: 8929  },
  // Hoodie: S — need to look up; we'll use sync variant lookup approach instead
  // Actually we store catalog variant_id in the sync variant response.
  // We already know t-shirt S = 8923. For others, let's query sync variants.
  { label: 'Hoodie S',                syncId: 5272191808 },
  { label: 'Hoodie 2XL',             syncId: 5272191812 },
  { label: 'Sweatpants S',            syncId: 5272192302 },
  { label: 'Sweatpants 3XL',          syncId: 5272192307 },
  { label: 'Snapback Hat',            syncId: 5272192548 },
  { label: 'Mug 12oz',               syncId: 5272193923 },
  { label: 'Water Bottle Black',      syncId: 5272195260 },
  { label: 'Tote Bag Black',          syncId: 5272199908 },
  { label: 'Sticker 3×3"',           syncId: 5272203897 },
  { label: 'Sticker 4×4"',           syncId: 5272203898 },
  { label: 'Sticker 5.5×5.5"',       syncId: 5272203899 },
  { label: 'Sticker 15×3.75"',       syncId: 5272203900 },
  { label: 'iPhone Case (iPhone 13)', syncId: 5272209148 },
  { label: 'Samsung Case (S23)',      syncId: 5272211118 },
  { label: 'Button Pins 1.25"',       syncId: 5272216401 },
  { label: 'Button Pins 2.25"',       syncId: 5272216402 },
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getCatalogId(syncId) {
  const r = await fetch(`${BASE}/store/variants/${syncId}`, { headers: HEADERS });
  const d = await r.json();
  if (!r.ok) throw new Error(`sync ${syncId}: ${d.error?.message}`);
  return d.result.variant_id;
}

async function getShipping(catalogId, recipient) {
  const body = {
    recipient,
    items: [{ quantity: 1, variant_id: catalogId }],
    currency: 'USD', locale: 'en_US',
  };
  const r = await fetch(`${BASE}/shipping/rates`, {
    method: 'POST', headers: HEADERS, body: JSON.stringify(body),
  });
  const d = await r.json();
  if (!r.ok || !d.result?.length) return null;
  // cheapest rate
  return d.result.reduce((a, b) => parseFloat(a.rate) <= parseFloat(b.rate) ? a : b);
}

async function main() {
  // Resolve all catalog IDs first
  const resolved = [];
  for (const v of VARIANTS) {
    let catId = v.id;
    if (!catId && v.syncId) {
      catId = await getCatalogId(v.syncId);
      await sleep(250);
    }
    resolved.push({ label: v.label, catId });
  }

  // Fetch shipping for both addresses
  const rows = [];
  for (const { label, catId } of resolved) {
    const la = await getShipping(catId, LA);
    await sleep(300);
    const uk = await getShipping(catId, UK);
    await sleep(300);
    rows.push({ label, catId, la, uk });
    process.stdout.write(`  fetched: ${label}\n`);
  }

  // Print table
  console.log('\n');
  const hdr = ['Product','Cat ID','LA (CONUS)','LA rate name','London (UK)','UK rate name'];
  const w   = [28, 9, 12, 28, 12, 28];
  const pad = (s,n) => String(s ?? 'n/a').padEnd(n);
  const lpad= (s,n) => String(s ?? 'n/a').padStart(n);
  const sep = w.map(n => '-'.repeat(n)).join('-+-');

  console.log(hdr.map((h,i) => pad(h,w[i])).join(' | '));
  console.log(sep);
  for (const r of rows) {
    const laRate  = r.la  ? `$${parseFloat(r.la.rate).toFixed(2)}`  : 'n/a';
    const ukRate  = r.uk  ? `$${parseFloat(r.uk.rate).toFixed(2)}`  : 'n/a';
    const laName  = r.la  ? r.la.name.trim().replace(/\s+/g,' ')    : 'n/a';
    const ukName  = r.uk  ? r.uk.name.trim().replace(/\s+/g,' ')    : 'n/a';
    console.log([
      pad(r.label, w[0]),
      lpad(r.catId, w[1]),
      lpad(laRate, w[2]),
      pad(laName.slice(0,26), w[3]),
      lpad(ukRate, w[4]),
      pad(ukName.slice(0,26), w[5]),
    ].join(' | '));
  }
  console.log(sep);
  console.log('\nNote: "n/a" means Printful cannot ship this variant to that destination.');
}

main().catch(err => { console.error(err); process.exit(1); });
