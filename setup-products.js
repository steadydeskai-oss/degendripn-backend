require('dotenv').config();
const fetch = require('node-fetch');

const API_KEY = process.env.PRINTFUL_API_KEY;
const BASE    = 'https://api.printful.com';

const TARGETS = [
  { label: 'Unisex T-Shirt',   terms: ['unisex t-shirt', 'unisex staple t-shirt', 'unisex jersey short sleeve', 'unisex softstyle', 'unisex classic tee'] },
  { label: 'Hoodie',           terms: ['unisex hoodie', 'pullover hoodie', 'hooded sweatshirt'] },
  { label: 'Sweatpants',       terms: ['sweatpant', 'fleece pant', 'jogger'] },
  { label: 'Snapback Cap',     terms: ['snapback'] },
  { label: 'Sticker',          terms: ['sticker'] },
  { label: 'Mug',              terms: ['mug'] },
  { label: 'Water Bottle',     terms: ['water bottle', 'tumbler', 'bottle'] },
  { label: 'Phone Case',       terms: ['phone case', 'iphone case', 'galaxy case', 'phone cover'] },
  { label: 'Canvas Tote Bag',  terms: ['tote bag', 'tote'] },
  { label: 'Button Pins',      terms: ['button pin', 'pinback button', 'round button pin', 'pin'] },
];

// Skip all-over print / cut-and-sew categories — they blow up memory and aren't DTG
const SKIP_CATEGORIES = new Set([305, 306, 307, 308]);

function matches(title, terms) {
  const t = title.toLowerCase();
  return TARGETS.filter(target => target.terms.some(term => t.includes(term)));
}

async function api(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

async function fetchVariants(productId) {
  try {
    const { result } = await api(`/products/${productId}`);
    return result.variants || [];
  } catch (e) {
    return [];
  }
}

async function main() {
  console.log('Fetching Printful category tree…');
  const catRes = await api('/categories');
  const categories = catRes.result.categories || catRes.result;
  console.log(`${categories.length} categories found.\n`);

  const seenProducts  = new Set(); // IDs already printed
  const scannedCatIds = new Set(); // category IDs already walked

  for (const cat of categories) {
    if (SKIP_CATEGORIES.has(cat.id)) {
      console.log(`  Skipping: ${cat.title} (id=${cat.id}) — all-over print, not relevant`);
      continue;
    }

    let offset = 0;
    const limit = 100;
    let pageNum = 0;

    while (true) {
      const { result: products } = await api(
        `/products?category_id=${cat.id}&limit=${limit}&offset=${offset}`
      );
      if (!products || products.length === 0) break;

      for (const product of products) {
        if (seenProducts.has(product.id)) continue;

        const hits = matches(product.title, TARGETS);
        if (hits.length === 0) {
          seenProducts.add(product.id); // mark seen, don't re-check
          continue;
        }

        seenProducts.add(product.id);
        const variants = await fetchVariants(product.id);

        for (const target of hits) {
          console.log(`\n[${target.label}] ${product.title}`);
          console.log(`  Product ID : ${product.id}  |  Type: ${product.type}`);
          console.log(`  Variants (${variants.length}):`);
          variants.slice(0, 20).forEach(v => {
            console.log(`    variant_id=${v.id}  |  ${v.name}  |  $${v.price}`);
          });
          if (variants.length > 20) {
            console.log(`    … and ${variants.length - 20} more`);
          }
        }
      }

      if (products.length < limit) break;
      offset += limit;
      pageNum++;
    }

    scannedCatIds.add(cat.id);
  }

  console.log('\n' + '='.repeat(70));
  console.log('Done. Products scanned: ' + seenProducts.size);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
