#!/usr/bin/env node
// Fetches all sync products from Printful and prints each product's
// name, sync variant IDs, sizes, and colors.
// Appends a "=== .env SUGGESTIONS ===" block at the end for easy copy-paste.

require('dotenv').config();

const API_KEY  = process.env.PRINTFUL_API_KEY;
const STORE_ID = process.env.PRINTFUL_STORE_ID;

if (!API_KEY)  { console.error('Missing PRINTFUL_API_KEY in .env'); process.exit(1); }
if (!STORE_ID) { console.error('Missing PRINTFUL_STORE_ID in .env'); process.exit(1); }

const HEADERS = {
  'Authorization': `Bearer ${API_KEY}`,
  'X-PF-Store-Id': STORE_ID,
};

// Env-var name formatters per product name (matched by substring, case-insensitive).
// Return null to skip a variant from the suggestions block.
const ENV_NAME_MAP = [
  {
    match: /t.?shirt/i,
    name: (size, color) => `PRINTFUL_TSHIRT_${colorSlug(color)}_${slug(size)}`,
  },
  {
    match: /hoodie/i,
    name: (size, color) => `PRINTFUL_HOODIE_${colorSlug(color)}_${slug(size)}`,
  },
  {
    match: /sweatpants/i,
    name: (size, color) => `PRINTFUL_SWEATPANTS_${colorSlug(color)}_${slug(size)}`,
  },
  {
    match: /snapback|hat/i,
    name: (size, color) => `PRINTFUL_SNAPBACK_${colorSlug(color)}`,
  },
  {
    match: /latte mug|ceramic mug|mug/i,
    name: () => `PRINTFUL_MUG`,
  },
  {
    match: /water.?bottle/i,
    name: (size, color) => `PRINTFUL_BOTTLE_${colorSlug(color)}`,
  },
  {
    match: /tote/i,
    name: (size, color) => `PRINTFUL_TOTE_${colorSlug(color)}`,
  },
  {
    match: /sticker/i,
    name: (size) => `PRINTFUL_STICKERS_${stickerSlug(size)}`,
  },
  {
    match: /iphone/i,
    name: (size) => `PRINTFUL_IPHONECASE_${iphoneSlug(size)}`,
  },
  {
    match: /samsung/i,
    name: (size) => `PRINTFUL_SAMSUNGCASE_${samsungSlug(size)}`,
  },
  {
    match: /pin/i,
    name: (size) => `PRINTFUL_PINS_${pinSlug(size)}`,
  },
];

function slug(s) {
  return (s || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}
function colorSlug(c) {
  return slug(c || 'DEFAULT');
}
function stickerSlug(s) {
  // "3″×3″" → "3X3", "5.5″×5.5″" → "55X55"
  return (s || '').replace(/[″"]/g, '').replace(/×/g, 'X').replace(/\./g, '').replace(/\s+/g, '').toUpperCase();
}
function iphoneSlug(s) {
  // "iPhone 11 Pro Max / Matte" → "IP11_PRO_MAX"
  return slug(s.replace(/^iPhone\s*/i, 'IP').replace(/\s*\/\s*Matte/i, ''));
}
function samsungSlug(s) {
  // "Samsung Galaxy S10 Plus / Matte" → "S10_PLUS"
  return slug(s.replace(/^Samsung Galaxy\s*/i, '').replace(/\s*\/\s*Matte/i, ''));
}
function pinSlug(s) {
  // "1.25″" → "1_25", "2.25″" → "2_25"
  return (s || '').replace(/[″"]/g, '').replace(/\./g, '_').replace(/\s+/g, '').toUpperCase();
}

function findEnvFormatter(productName) {
  const cfg = ENV_NAME_MAP.find(c => c.match.test(productName));
  return cfg ? cfg.name : null;
}

async function pf(path) {
  const res = await fetch(`https://api.printful.com${path}`, { headers: HEADERS });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Printful ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

async function getAllSyncProducts() {
  const products = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const data = await pf(`/sync/products?limit=${limit}&offset=${offset}`);
    products.push(...data.result);
    if (products.length >= data.paging.total) break;
    offset += limit;
  }
  return products;
}

(async () => {
  console.log(`\nFetching sync products from store ${STORE_ID}...\n`);

  const products = await getAllSyncProducts();
  console.log(`Found ${products.length} sync product(s).\n`);
  console.log('='.repeat(72));

  const envLines = [];

  for (const prod of products) {
    const detail = await pf(`/sync/products/${prod.id}`);
    const { sync_product, sync_variants } = detail.result;

    console.log(`\n▸ ${sync_product.name}  (sync_product_id: ${sync_product.id})`);
    console.log(`  Variants: ${sync_variants.length}`);

    const fmt = findEnvFormatter(sync_product.name);
    if (fmt) envLines.push(`# ${sync_product.name}`);

    for (const v of sync_variants) {
      const size  = v.size  || v.name || '—';
      const color = v.color || '';
      const sku   = v.sku   ? `  sku:${v.sku}` : '';
      const label = color ? `${size} / ${color}` : size;
      console.log(`    sync_variant_id: ${String(v.id).padEnd(12)}  ${label.padEnd(36)}${sku}`);

      if (fmt) {
        const varName = fmt(size, color);
        envLines.push(`${varName}=${v.id}`);
      }
    }

    if (fmt) envLines.push('');
  }

  console.log('\n' + '='.repeat(72));

  // Print .env suggestions
  console.log('\n=== .env SUGGESTIONS (copy into your .env) ===\n');
  console.log(envLines.join('\n'));
  console.log('\n=== END SUGGESTIONS ===\n');

  console.log('Done.\n');
})().catch(err => { console.error('Error:', err.message); process.exit(1); });
