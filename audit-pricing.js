// Pricing audit — reads sync variant costs from Printful, compares to site prices
// Usage: node audit-pricing.js
require('dotenv').config();

const API_KEY    = process.env.PRINTFUL_API_KEY;
const STORE_ID   = process.env.PRINTFUL_STORE_ID;
const BASE       = 'https://api.printful.com';
const HEADERS    = { Authorization: `Bearer ${API_KEY}`, 'X-PF-Store-Id': STORE_ID };
const AVG_SHIP   = 5.00; // avg domestic shipping we absorb

// One representative variant per product group (we only need one to get cost)
// For products with size-based pricing, pick the cheapest size first, then 2XL for uplift check
const GROUPS = [
  { product: 'T-Shirt (S–XL)',         site: 32,  varIds: [5272190313, 5272190314, 5272190315, 5272190316] },
  { product: 'T-Shirt (2XL)',           site: 32,  varIds: [5272190317] },
  { product: 'Hoodie (S–XL)',           site: 58,  varIds: [5272191808, 5272191809, 5272191810, 5272191811] },
  { product: 'Hoodie (2XL)',            site: 58,  varIds: [5272191812] },
  { product: 'Sweatpants (S–XL)',       site: 45,  varIds: [5272192302, 5272192303, 5272192304, 5272192305] },
  { product: 'Sweatpants (2XL)',        site: 45,  varIds: [5272192306] },
  { product: 'Sweatpants (3XL)',        site: 45,  varIds: [5272192307] },
  { product: 'Snapback Hat',            site: 35,  varIds: [5272192548] },
  { product: 'Mug 12oz',               site: 22,  varIds: [5272193923] },
  { product: 'Water Bottle (Black)',    site: 35,  varIds: [5272195260] },
  { product: 'Water Bottle (White)',    site: 35,  varIds: [5272195261] },
  { product: 'Tote Bag (Black)',        site: 24,  varIds: [5272199908] },
  { product: 'Tote Bag (Oyster)',       site: 24,  varIds: [5272199909] },
  { product: 'Sticker 3×3"',           site: 5,   varIds: [5272203897] },
  { product: 'Sticker 4×4"',           site: 8,   varIds: [5272203898] },
  { product: 'Sticker 5.5×5.5"',       site: 12,  varIds: [5272203899] },
  { product: 'Sticker 15×3.75"',       site: 12,  varIds: [5272203900] },
  { product: 'iPhone Case',            site: 28,  varIds: [5272209148] }, // iPhone 13 as sample
  { product: 'Samsung Case',           site: 28,  varIds: [5272211118] }, // Galaxy S23 as sample
  { product: 'Button Pins 1.25"',      site: 10,  varIds: [5272216401] },
  { product: 'Button Pins 2.25"',      site: 10,  varIds: [5272216402] },
];

async function fetchVariant(syncVarId) {
  const r = await fetch(`${BASE}/store/variants/${syncVarId}`, { headers: HEADERS });
  const d = await r.json();
  if (!r.ok) throw new Error(`variant ${syncVarId}: ${d.error?.message || r.status}`);
  return d.result;
}

async function fetchCatalogVariant(catalogVarId) {
  const r = await fetch(`${BASE}/products/variant/${catalogVarId}`, { headers: HEADERS });
  const d = await r.json();
  if (!r.ok) throw new Error(`catalog ${catalogVarId}: ${d.error?.message || r.status}`);
  return d.result.variant;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const rows = [];

  for (const group of GROUPS) {
    // Fetch one representative sync variant
    const syncVar = await fetchVariant(group.varIds[0]);
    await sleep(300); // rate-limit guard

    const catalogVarId = syncVar.variant_id;
    let pfCost = null;
    if (catalogVarId) {
      const catalogVar = await fetchCatalogVariant(catalogVarId);
      await sleep(300);
      pfCost = parseFloat(catalogVar.price);
    }

    // If multiple varIds in group, check them all for cost spread (e.g. 2XL upcharge)
    // We already got the first; if group has more, sample last one
    if (group.varIds.length > 1) {
      const last = group.varIds[group.varIds.length - 1];
      if (last !== group.varIds[0]) {
        const sv2 = await fetchVariant(last);
        await sleep(300);
        const cv2Id = sv2.variant_id;
        if (cv2Id) {
          const cv2 = await fetchCatalogVariant(cv2Id);
          await sleep(300);
          const pfCost2 = parseFloat(cv2.price);
          if (pfCost2 !== pfCost) {
            // Record both
            rows.push(buildRow(`${group.product} (rep)`, group.site, pfCost));
            pfCost = pfCost2;
          }
        }
      }
    }

    rows.push(buildRow(group.product, group.site, pfCost));
  }

  // Print table
  const header = ['Product','PF Cost','+ Ship','Total Cost','Min Viable (×1.5)','Site Price','Margin $','Margin %','Status'];
  const colW = [26, 9, 7, 11, 18, 11, 9, 9, 8];

  function pad(s, w) { return String(s).padEnd(w); }
  function lpad(s, w) { return String(s).padStart(w); }

  const sep = colW.map(w => '-'.repeat(w)).join('-+-');
  console.log('\n' + header.map((h,i) => pad(h, colW[i])).join(' | '));
  console.log(sep);
  for (const r of rows) {
    const flag = r.status === 'LOSS' ? ' *** LOSING MONEY' : r.status === 'TIGHT' ? ' * tight' : '';
    console.log([
      pad(r.product, colW[0]),
      lpad(`$${r.pfCost.toFixed(2)}`, colW[1]),
      lpad(`$${AVG_SHIP.toFixed(2)}`, colW[2]),
      lpad(`$${r.totalCost.toFixed(2)}`, colW[3]),
      lpad(`$${r.minViable.toFixed(2)}`, colW[4]),
      lpad(`$${r.sitePrice.toFixed(2)}`, colW[5]),
      lpad(`$${r.marginDollar.toFixed(2)}`, colW[6]),
      lpad(`${r.marginPct.toFixed(0)}%`, colW[7]),
      pad(r.status + flag, 30),
    ].join(' | '));
  }
  console.log(sep);
  console.log('\nMargin % = (site_price - pf_cost) / site_price  (excludes shipping we absorb)');
  console.log('Min Viable = (pf_cost + avg_ship) × 1.5');
  console.log('TIGHT = site price within 20% above min viable');
  console.log('LOSS  = site price below min viable\n');
}

function buildRow(product, sitePrice, pfCost) {
  const totalCost  = pfCost + AVG_SHIP;
  const minViable  = totalCost * 1.5;
  const marginDollar = sitePrice - pfCost;
  const marginPct  = (marginDollar / sitePrice) * 100;
  const status = sitePrice < minViable ? 'LOSS' : sitePrice < minViable * 1.2 ? 'TIGHT' : 'OK';
  return { product, pfCost, totalCost, minViable, sitePrice, marginDollar, marginPct, status };
}

main().catch(err => { console.error(err); process.exit(1); });
