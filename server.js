require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const Jimp    = require('jimp');
const fetch   = require('node-fetch');
const stripe  = require('stripe')(process.env.STRIPE_SECRET_KEY);
const fs      = require('fs');
const path    = require('path');
const { checkText, checkCart } = require('./moderation');

const app  = express();
const PORT = process.env.PORT || 3001;

// ─── Pending orders store ──────────────────────────────────────────────────────
// Orders held for content review (soft-block). Persisted to JSON file so they
// survive server restarts within the same deployment. For production, replace
// with a proper database (Postgres/Redis).
const PENDING_FILE = path.join(__dirname, 'pending-orders.json');
let _pendingData = {};
try { _pendingData = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8')); } catch {}
const pendingOrders = new Map(Object.entries(_pendingData)); // id → order object

function savePendingOrders() {
  const obj = {};
  for (const [k, v] of pendingOrders) obj[k] = v;
  try { fs.writeFileSync(PENDING_FILE, JSON.stringify(obj, null, 2)); } catch {}
}

// ─── Admin auth middleware ────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const adminPw = process.env.ADMIN_PASSWORD;
  if (!adminPw) return res.status(503).json({ error: 'ADMIN_PASSWORD not configured' });
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (token !== adminPw) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ─── Disk-backed mockup cache ─────────────────────────────────────────────────
const MOCKUP_CACHE_FILE = path.join(__dirname, 'mockup-cache.json');
let _cacheData = {};
try { _cacheData = JSON.parse(fs.readFileSync(MOCKUP_CACHE_FILE, 'utf8')); } catch {}
const mockupCache = new Map(
  Object.entries(_cacheData).filter(([k]) => !k.startsWith('v2:mug:') && !k.startsWith('v2:pins:'))
);

function saveMockupCache() {
  const obj = {};
  for (const [k, v] of mockupCache) obj[k] = v;
  try { fs.writeFileSync(MOCKUP_CACHE_FILE, JSON.stringify(obj)); } catch {}
}

// ─── Print area info cache (productKey → full info including template) ────────
const printAreaInfoCache = new Map();

// ─── Catalog product photo cache (catalogProductId → imageUrl) ────────────────
const catalogPhotoCache = new Map();

async function getCatalogProductPhoto(catalogProductId, pfHeaders) {
  if (catalogPhotoCache.has(catalogProductId)) return catalogPhotoCache.get(catalogProductId);
  try {
    const res  = await fetch(`https://api.printful.com/products/${catalogProductId}`, { headers: pfHeaders });
    const data = await res.json();
    const url  = data.result?.product?.image || null;
    if (url) catalogPhotoCache.set(catalogProductId, url);
    return url;
  } catch { return null; }
}

// Wrap an image URL through wsrv.nl so Printful can fetch it (follows redirects, converts WebP→PNG).
// If already a wsrv.nl URL, extract the inner source URL and re-wrap with our standard params so
// the final URL is always properly encoded (raw wsrv.nl URLs from the frontend aren't encoded).
function proxyImageUrl(url) {
  if (url.startsWith('https://wsrv.nl/') || url.startsWith('http://wsrv.nl/')) {
    try {
      const src = new URL(url).searchParams.get('url');
      if (src) return `https://wsrv.nl/?url=${encodeURIComponent(src)}&output=png&w=1800`;
    } catch {}
  }
  return `https://wsrv.nl/?url=${encodeURIComponent(url)}&output=png&w=1800`;
}

// Fetch, compute and cache everything needed for a product's print area:
// catalog IDs, print dimensions, placement name, and template overlay coords.
async function getProductPrintInfo(productKey, pfHeaders, color, size) {
  const cacheKey = `${productKey}:${color || ''}:${size || ''}`;
  if (printAreaInfoCache.has(cacheKey)) return printAreaInfoCache.get(cacheKey);

  let syncVariantId;
  if (color) {
    const variantMap = buildVariantMap()[productKey] || {};
    // Try exact size|color match first, then any color match
    const exactMatch = size ? Object.entries(variantMap).find(([k]) => k === `${size}|${color}`) : null;
    const colorMatch = Object.entries(variantMap).find(([k]) => k.split('|')[1] === color);
    syncVariantId = exactMatch?.[1] ?? colorMatch?.[1] ?? REPRESENTATIVE_SYNC_VARIANTS[productKey]?.();
  } else {
    syncVariantId = REPRESENTATIVE_SYNC_VARIANTS[productKey]?.();
  }
  if (!syncVariantId) throw new Error(`No sync variant configured for: ${productKey}${color ? ` (${color})` : ''}`);

  // Resolve catalog variant + product IDs
  const svRes  = await fetch(`https://api.printful.com/sync/variant/${syncVariantId}`, { headers: pfHeaders });
  const svData = await svRes.json();
  if (!svRes.ok) throw new Error(`Sync variant lookup failed: ${svData.error?.message}`);

  const catalogVariantId = svData.result.sync_variant.variant_id;
  const catalogProductId = svData.result.sync_variant.product.product_id;
  const svFiles = svData.result.sync_variant.files ?? [];
  const variantPreviewUrl = svFiles.find(f => f.type === 'preview')?.preview_url
                         ?? svFiles[0]?.preview_url
                         ?? null;

  // Get printfile dimensions (the actual print area in pixels)
  const pfRes  = await fetch(`https://api.printful.com/mockup-generator/printfiles/${catalogProductId}`, { headers: pfHeaders });
  const pfData = await pfRes.json();

  const variantPf = pfData.result?.variant_printfiles?.[0]?.placements ?? {};
  let placementName = 'front';
  if (!variantPf.front) {
    if (variantPf.front_large) placementName = 'front_large';
    else if (Object.keys(variantPf).length > 0) placementName = Object.keys(variantPf)[0];
  }
  const pfId     = variantPf[placementName];
  const printfile = pfData.result?.printfiles?.find(p => p.printfile_id === pfId)
                 ?? pfData.result?.printfiles?.[0];
  const area_width  = printfile?.width  ?? 1800;
  const area_height = printfile?.height ?? 2400;

  // Get template overlay coordinates (where the print area sits on the product photo)
  let template = null;
  try {
    const tmRes  = await fetch(`https://api.printful.com/mockup-generator/templates/${catalogProductId}`, { headers: pfHeaders });
    const tmData = await tmRes.json();

    // Find the template for our variant; fall back to first available
    const variantMapping = tmData.result?.variant_mapping ?? [];
    const variantMap     = variantMapping.find(v => v.variant_id === catalogVariantId);
    const templateId     = variantMap?.templates?.[0]?.template_id
                        ?? tmData.result?.templates?.[0]?.template_id;
    const tmpl           = tmData.result?.templates?.find(t => t.template_id === templateId)
                        ?? tmData.result?.templates?.[0];

    if (tmpl) {
      template = {
        imageUrl:        tmpl.image_url,
        templateWidth:   tmpl.template_width,
        templateHeight:  tmpl.template_height,
        printAreaTop:    tmpl.print_area_top,
        printAreaLeft:   tmpl.print_area_left,
        printAreaWidth:  tmpl.print_area_width,
        printAreaHeight: tmpl.print_area_height,
      };
    }
  } catch {}

  // Always fetch catalog product photo — used as canvas background (cleaner than template overlay images)
  const catalogPhotoUrl = await getCatalogProductPhoto(catalogProductId, pfHeaders);

  // If template API returned nothing usable, synthesize a full-area template from the catalog photo
  if (!template || !template.imageUrl) {
    template = {
      imageUrl:        catalogPhotoUrl || '',
      templateWidth:   area_width,
      templateHeight:  area_height,
      printAreaTop:    0,
      printAreaLeft:   0,
      printAreaWidth:  area_width,
      printAreaHeight: area_height,
    };
  }

  console.log(`[PrintInfo] ${productKey}${color?`:${color}`:''}${size?`:${size}`:''}: template.imageUrl=${template.imageUrl || 'null'} catalogPhotoUrl=${catalogPhotoUrl || 'null'}`);

  const info = { catalogProductId, catalogVariantId, placementName, area_width, area_height, template, catalogPhotoUrl, variantPreviewUrl };
  printAreaInfoCache.set(cacheKey, info);
  return info;
}

// Representative sync variant per product — used for mockup catalog ID resolution.
const REPRESENTATIVE_SYNC_VARIANTS = {
  tshirt:              () => process.env.PRINTFUL_TSHIRT_WHITE_M,
  hoodie:              () => process.env.PRINTFUL_HOODIE_WHITE_M,
  sweatpants:          () => process.env.PRINTFUL_SWEATPANTS_BLACK_M,
  snapback:            () => process.env.PRINTFUL_SNAPBACK_WHITE,
  stickers:            () => process.env.PRINTFUL_STICKERS_3X3,
  mug:                 () => process.env.PRINTFUL_MUG,
  waterbottle:         () => process.env.PRINTFUL_BOTTLE_WHITE,
  tote:                () => process.env.PRINTFUL_TOTE_BLACK,
  pins:                () => process.env.PRINTFUL_PINS_2_25,
  'phonecase-iphone':  () => process.env.PRINTFUL_IPHONECASE_IP15,
  'phonecase-samsung': () => process.env.PRINTFUL_SAMSUNGCASE_S24,
};

// ─── Variant lookup ───────────────────────────────────────────────────────────
function buildVariantMap() {
  const e = process.env;
  return {
    tshirt: {
      'S|Black Heather':   e.PRINTFUL_TSHIRT_BLACK_HEATHER_S,
      'M|Black Heather':   e.PRINTFUL_TSHIRT_BLACK_HEATHER_M,
      'L|Black Heather':   e.PRINTFUL_TSHIRT_BLACK_HEATHER_L,
      'XL|Black Heather':  e.PRINTFUL_TSHIRT_BLACK_HEATHER_XL,
      '2XL|Black Heather': e.PRINTFUL_TSHIRT_BLACK_HEATHER_2XL,
      'S|White':           e.PRINTFUL_TSHIRT_WHITE_S,
      'M|White':           e.PRINTFUL_TSHIRT_WHITE_M,
      'L|White':           e.PRINTFUL_TSHIRT_WHITE_L,
      'XL|White':          e.PRINTFUL_TSHIRT_WHITE_XL,
      '2XL|White':         e.PRINTFUL_TSHIRT_WHITE_2XL,
    },
    hoodie: {
      'S|Black':   e.PRINTFUL_HOODIE_BLACK_S,   'M|Black':   e.PRINTFUL_HOODIE_BLACK_M,
      'L|Black':   e.PRINTFUL_HOODIE_BLACK_L,   'XL|Black':  e.PRINTFUL_HOODIE_BLACK_XL,
      '2XL|Black': e.PRINTFUL_HOODIE_BLACK_2XL,
      'S|White':   e.PRINTFUL_HOODIE_WHITE_S,   'M|White':   e.PRINTFUL_HOODIE_WHITE_M,
      'L|White':   e.PRINTFUL_HOODIE_WHITE_L,   'XL|White':  e.PRINTFUL_HOODIE_WHITE_XL,
      '2XL|White': e.PRINTFUL_HOODIE_WHITE_2XL,
    },
    sweatpants: {
      'S|Black':              e.PRINTFUL_SWEATPANTS_BLACK_S,
      'M|Black':              e.PRINTFUL_SWEATPANTS_BLACK_M,
      'L|Black':              e.PRINTFUL_SWEATPANTS_BLACK_L,
      'XL|Black':             e.PRINTFUL_SWEATPANTS_BLACK_XL,
      '2XL|Black':            e.PRINTFUL_SWEATPANTS_BLACK_2XL,
      '3XL|Black':            e.PRINTFUL_SWEATPANTS_BLACK_3XL,
      'S|Athletic Heather':   e.PRINTFUL_SWEATPANTS_ATHLETIC_HEATHER_S,
      'M|Athletic Heather':   e.PRINTFUL_SWEATPANTS_ATHLETIC_HEATHER_M,
      'L|Athletic Heather':   e.PRINTFUL_SWEATPANTS_ATHLETIC_HEATHER_L,
      'XL|Athletic Heather':  e.PRINTFUL_SWEATPANTS_ATHLETIC_HEATHER_XL,
      '2XL|Athletic Heather': e.PRINTFUL_SWEATPANTS_ATHLETIC_HEATHER_2XL,
      '3XL|Athletic Heather': e.PRINTFUL_SWEATPANTS_ATHLETIC_HEATHER_3XL,
    },
    snapback:     { 'One Size|Dark Navy': e.PRINTFUL_SNAPBACK_DARK_NAVY, 'One Size|White': e.PRINTFUL_SNAPBACK_WHITE },
    stickers:     { '3×3 inch': e.PRINTFUL_STICKERS_3X3, '4×4 inch': e.PRINTFUL_STICKERS_4X4, '5.5×5.5 inch': e.PRINTFUL_STICKERS_55X55, '15×3.75 inch': e.PRINTFUL_STICKERS_15X375 },
    mug:          { 'One Size': e.PRINTFUL_MUG },
    waterbottle:  { 'One Size|Black': e.PRINTFUL_BOTTLE_BLACK, 'One Size|White': e.PRINTFUL_BOTTLE_WHITE },
    tote:         { 'One Size|Black': e.PRINTFUL_TOTE_BLACK, 'One Size|Oyster': e.PRINTFUL_TOTE_OYSTER },
    pins:         { '1.25 inch': e.PRINTFUL_PINS_1_25, '2.25 inch': e.PRINTFUL_PINS_2_25 },
    'phonecase-iphone': {
      'iPhone 11': e.PRINTFUL_IPHONECASE_IP11, 'iPhone 11 Pro': e.PRINTFUL_IPHONECASE_IP11_PRO,
      'iPhone 11 Pro Max': e.PRINTFUL_IPHONECASE_IP11_PRO_MAX, 'iPhone 12 Mini': e.PRINTFUL_IPHONECASE_IP12_MINI,
      'iPhone 12': e.PRINTFUL_IPHONECASE_IP12, 'iPhone 12 Pro': e.PRINTFUL_IPHONECASE_IP12_PRO,
      'iPhone 12 Pro Max': e.PRINTFUL_IPHONECASE_IP12_PRO_MAX, 'iPhone 13 Mini': e.PRINTFUL_IPHONECASE_IP13_MINI,
      'iPhone 13': e.PRINTFUL_IPHONECASE_IP13, 'iPhone 13 Pro': e.PRINTFUL_IPHONECASE_IP13_PRO,
      'iPhone 13 Pro Max': e.PRINTFUL_IPHONECASE_IP13_PRO_MAX, 'iPhone 14': e.PRINTFUL_IPHONECASE_IP14,
      'iPhone 14 Plus': e.PRINTFUL_IPHONECASE_IP14_PLUS, 'iPhone 14 Pro': e.PRINTFUL_IPHONECASE_IP14_PRO,
      'iPhone 14 Pro Max': e.PRINTFUL_IPHONECASE_IP14_PRO_MAX, 'iPhone 15': e.PRINTFUL_IPHONECASE_IP15,
      'iPhone 15 Plus': e.PRINTFUL_IPHONECASE_IP15_PLUS, 'iPhone 15 Pro': e.PRINTFUL_IPHONECASE_IP15_PRO,
      'iPhone 15 Pro Max': e.PRINTFUL_IPHONECASE_IP15_PRO_MAX, 'iPhone 16': e.PRINTFUL_IPHONECASE_IP16,
      'iPhone 16 Plus': e.PRINTFUL_IPHONECASE_IP16_PLUS, 'iPhone 16 Pro': e.PRINTFUL_IPHONECASE_IP16_PRO,
      'iPhone 16 Pro Max': e.PRINTFUL_IPHONECASE_IP16_PRO_MAX, 'iPhone 17': e.PRINTFUL_IPHONECASE_IP17,
      'iPhone 17 Air': e.PRINTFUL_IPHONECASE_IP17_AIR, 'iPhone 17 Pro': e.PRINTFUL_IPHONECASE_IP17_PRO,
      'iPhone 17 Pro Max': e.PRINTFUL_IPHONECASE_IP17_PRO_MAX,
    },
    'phonecase-samsung': {
      'Samsung Galaxy S10': e.PRINTFUL_SAMSUNGCASE_S10, 'Samsung Galaxy S10e': e.PRINTFUL_SAMSUNGCASE_S10E,
      'Samsung Galaxy S10 Plus': e.PRINTFUL_SAMSUNGCASE_S10_PLUS,
      'Samsung Galaxy S20': e.PRINTFUL_SAMSUNGCASE_S20, 'Samsung Galaxy S20 FE': e.PRINTFUL_SAMSUNGCASE_S20_FE,
      'Samsung Galaxy S20 Plus': e.PRINTFUL_SAMSUNGCASE_S20_PLUS, 'Samsung Galaxy S20 Ultra': e.PRINTFUL_SAMSUNGCASE_S20_ULTRA,
      'Samsung Galaxy S21': e.PRINTFUL_SAMSUNGCASE_S21, 'Samsung Galaxy S21 Plus': e.PRINTFUL_SAMSUNGCASE_S21_PLUS,
      'Samsung Galaxy S21 Ultra': e.PRINTFUL_SAMSUNGCASE_S21_ULTRA, 'Samsung Galaxy S21 FE': e.PRINTFUL_SAMSUNGCASE_S21_FE,
      'Samsung Galaxy S22': e.PRINTFUL_SAMSUNGCASE_S22, 'Samsung Galaxy S22 Plus': e.PRINTFUL_SAMSUNGCASE_S22_PLUS,
      'Samsung Galaxy S22 Ultra': e.PRINTFUL_SAMSUNGCASE_S22_ULTRA,
      'Samsung Galaxy S23': e.PRINTFUL_SAMSUNGCASE_S23, 'Samsung Galaxy S23 Plus': e.PRINTFUL_SAMSUNGCASE_S23_PLUS,
      'Samsung Galaxy S23 Ultra': e.PRINTFUL_SAMSUNGCASE_S23_ULTRA,
      'Samsung Galaxy S24': e.PRINTFUL_SAMSUNGCASE_S24, 'Samsung Galaxy S24 Plus': e.PRINTFUL_SAMSUNGCASE_S24_PLUS,
      'Samsung Galaxy S24 Ultra': e.PRINTFUL_SAMSUNGCASE_S24_ULTRA,
      'Samsung Galaxy S25': e.PRINTFUL_SAMSUNGCASE_S25, 'Samsung Galaxy S25 Plus': e.PRINTFUL_SAMSUNGCASE_S25_PLUS,
      'Samsung Galaxy S25 Ultra': e.PRINTFUL_SAMSUNGCASE_S25_ULTRA,
    },
  };
}

function getVariantId(pid, size, color) {
  const m = buildVariantMap()[pid];
  if (!m) return null;
  if (color) return m[`${size}|${color}`] ?? m[size] ?? null;
  return m[size] ?? null;
}

// ─── Middleware ───────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://degendrip.net',
  'https://www.degendrip.net',
  'https://degendrip.netlify.app',
  'http://localhost:5500',
];
app.use(cors({
  origin: (origin, cb) => cb(null, !origin || ALLOWED_ORIGINS.includes(origin)),
  credentials: true,
}));
app.use('/api/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ limit: '25mb', extended: true }));

// ─── Frontend ─────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.resolve(__dirname, '../DegenDrip_v14.html')));

// ─── Admin dashboard ──────────────────────────────────────────────────────────
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ ok: true }));

// ─── Text moderation check ────────────────────────────────────────────────────
app.post('/api/check-text', (req, res) => {
  const { text } = req.body;
  if (typeof text !== 'string') return res.status(400).json({ error: 'Missing text' });
  const result = checkText(text);
  res.json(result);
});

// ─── Stock status ─────────────────────────────────────────────────────────────
const stockCache = new Map(); // productKey -> { data, expiresAt }
const STOCK_CACHE_TTL = 5 * 60 * 1000;

app.get('/api/stock/:productKey', async (req, res) => {
  const { productKey } = req.params;
  const cached = stockCache.get(productKey);
  if (cached && Date.now() < cached.expiresAt) return res.json(cached.data);

  const pfHeaders = { Authorization: `Bearer ${process.env.PRINTFUL_API_KEY}` };
  try {
    const repVariantId = REPRESENTATIVE_SYNC_VARIANTS[productKey]?.();
    if (!repVariantId) return res.status(404).json({ error: 'Unknown product' });

    const repRes  = await fetch(`https://api.printful.com/sync/variant/${repVariantId}`, { headers: pfHeaders });
    const repData = await repRes.json();
    const syncProductId = repData.result?.sync_variant?.sync_product_id;
    if (!syncProductId) return res.status(500).json({ error: 'Could not resolve sync product' });

    const prodRes  = await fetch(`https://api.printful.com/sync/product/${syncProductId}`, { headers: pfHeaders });
    const prodData = await prodRes.json();
    const variants = prodData.result?.sync_variants || [];

    const variantMap = buildVariantMap()[productKey] || {};
    const ourSizes = new Set(Object.keys(variantMap).map(k => k.includes('|') ? k.split('|')[0] : k));
    // Case-insensitive lookup: Printful may return "One size" while our keys use "One Size"
    const normSizeMap = new Map([...ourSizes].map(s => [s.toLowerCase(), s]));

    // Per-size: available if ANY color variant for it is active
    // Per-color: tracked independently so color buttons can be marked OOS
    const sizeStatusMap = {};
    const colorStatusMap = {};
    for (const v of variants) {
      const pfSize  = v.size  || '';
      const color   = v.color || '';
      const status  = v.availability_status;
      const ourSize = normSizeMap.get(pfSize.toLowerCase());

      if (ourSize) {
        if (!sizeStatusMap[ourSize] || status === 'active') sizeStatusMap[ourSize] = status;
      }
      if (color) {
        if (!colorStatusMap[color] || status === 'active') colorStatusMap[color] = status;
      }
    }

    const allOutOfStock = ourSizes.size > 0 &&
      [...ourSizes].every(s => sizeStatusMap[s] && sizeStatusMap[s] !== 'active');

    const data = { sizes: sizeStatusMap, colors: colorStatusMap, allOutOfStock };
    stockCache.set(productKey, { data, expiresAt: Date.now() + STOCK_CACHE_TTL });
    console.log(`[Stock] ${productKey}: sizes=${JSON.stringify(sizeStatusMap)} colors=${JSON.stringify(colorStatusMap)}`);
    res.json(data);
  } catch (err) {
    console.error('[Stock]', productKey, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── COLOR DETECTION ─────────────────────────────────────────────────────────
app.get('/api/color', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url param' });
  try {
    const image = await Jimp.read(url);
    const w = image.getWidth() - 1, h = image.getHeight() - 1;
    const corners = [
      Jimp.intToRGBA(image.getPixelColor(0, 0)), Jimp.intToRGBA(image.getPixelColor(w, 0)),
      Jimp.intToRGBA(image.getPixelColor(0, h)), Jimp.intToRGBA(image.getPixelColor(w, h)),
    ].filter(c => c.a > 20);
    if (!corners.length) return res.json({ color: '#ffffff' });
    const r = Math.round(corners.reduce((s,c) => s+c.r, 0) / corners.length);
    const g = Math.round(corners.reduce((s,c) => s+c.g, 0) / corners.length);
    const b = Math.round(corners.reduce((s,c) => s+c.b, 0) / corners.length);
    res.json({ color: '#' + [r,g,b].map(x => x.toString(16).padStart(2,'0')).join('') });
  } catch (err) {
    res.json({ color: '#ffffff' });
  }
});

// ─── PRINT AREA INFO ──────────────────────────────────────────────────────────
// Returns catalog IDs, print dimensions, placement name, and template overlay data.
app.get('/api/printarea/:productKey', async (req, res) => {
  const { productKey } = req.params;
  const color = req.query.color || null;
  if (!REPRESENTATIVE_SYNC_VARIANTS[productKey])
    return res.status(404).json({ error: 'Unknown product key' });
  if (!process.env.PRINTFUL_API_KEY)
    return res.status(503).json({ error: 'Printful API key not configured' });

  const pfHeaders = {
    'Authorization': `Bearer ${process.env.PRINTFUL_API_KEY}`,
    'X-PF-Store-Id':  process.env.PRINTFUL_STORE_ID || '',
  };
  try {
    const info = await getProductPrintInfo(productKey, pfHeaders, color);
    res.json(info);
  } catch (err) {
    console.error(`Print area error [${productKey}${color ? `:${color}` : ''}]:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── CATALOG PRODUCT PHOTO ───────────────────────────────────────────────────
app.get('/api/productphoto/:catalogProductId', async (req, res) => {
  const id = parseInt(req.params.catalogProductId, 10);
  if (!id) return res.status(400).json({ error: 'Invalid catalog product ID' });
  if (!process.env.PRINTFUL_API_KEY)
    return res.status(503).json({ error: 'Printful API key not configured' });

  const pfHeaders = {
    'Authorization': `Bearer ${process.env.PRINTFUL_API_KEY}`,
    'X-PF-Store-Id':  process.env.PRINTFUL_STORE_ID || '',
  };
  try {
    const url = await getCatalogProductPhoto(id, pfHeaders);
    if (!url) return res.status(404).json({ error: 'No photo found' });
    res.json({ imageUrl: url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── TEMP IMAGE STORE ────────────────────────────────────────────────────────
// Content-addressable: keyed by sha256 of image bytes.
// Same pixel content → same hash → same URL → mockup cache hits.
const tempImageStore = new Map(); // contentHash → { buffer, created, designUrl? }
setInterval(() => {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [hash, entry] of tempImageStore)
    if (entry.created < cutoff) tempImageStore.delete(hash);
}, 60_000);

// Serve a temporarily stored image (Printful fetches this during file upload)
app.get('/api/tmp/:uuid', (req, res) => {
  const entry = tempImageStore.get(req.params.uuid);
  if (!entry) return res.status(404).send('Not found');
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.send(entry.buffer);
});

// POST /api/upload-design
// Body: { base64: "data:image/png;base64,..." }
// Stores the image, gives Printful a URL to fetch it, returns a Printful CDN URL.
// Requires BACKEND_URL env var so Printful can reach /api/tmp/:uuid.
app.post('/api/upload-design', async (req, res) => {
  const { base64 } = req.body;
  if (!base64) return res.status(400).json({ error: 'Missing base64' });

  try {
    const b64 = base64.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(b64, 'base64');

    // Content-addressable key: sha256 of raw image bytes.
    // Same composite (same logo position + text + colors) → same hash → same URL → mockup cache hits.
    const { createHash } = require('crypto');
    const contentHash = createHash('sha256').update(buffer).digest('hex');

    // If we've already processed this exact image, return the cached designUrl immediately.
    const existing = tempImageStore.get(contentHash);
    if (existing?.designUrl) {
      console.log(`[upload-design] CACHE HIT hash=${contentHash.slice(0,12)}… — reusing ${existing.designUrl}`);
      return res.json({ designUrl: existing.designUrl, contentHash });
    }

    // Store buffer (or refresh TTL for an entry without a designUrl yet)
    tempImageStore.set(contentHash, { buffer, created: Date.now(), designUrl: null });
    console.log(`[upload-design] New image ${(buffer.length / 1024).toFixed(0)} KB → hash=${contentHash.slice(0,12)}…`);

    // Auto-detect Railway public URL so BACKEND_URL doesn't need to be set manually
    const backendUrl = (
      process.env.BACKEND_URL ||
      (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '')
    ).replace(/\/$/, '');
    if (!backendUrl) {
      console.warn('[upload-design] BACKEND_URL not set and RAILWAY_PUBLIC_DOMAIN not available — cannot make image public for Printful');
      return res.json({ designUrl: null });
    }

    const tempUrl = `${backendUrl}/api/tmp/${contentHash}`;

    if (!process.env.PRINTFUL_API_KEY) return res.json({ designUrl: tempUrl, contentHash });

    // Upload to Printful file library → permanent CDN URL
    const pfHeaders = {
      'Authorization': `Bearer ${process.env.PRINTFUL_API_KEY}`,
      'X-PF-Store-Id':  process.env.PRINTFUL_STORE_ID || '',
      'Content-Type':   'application/json',
    };
    const uploadRes  = await fetch('https://api.printful.com/files', {
      method:  'POST',
      headers: pfHeaders,
      body:    JSON.stringify({ type: 'default', url: tempUrl, filename: `design_${contentHash.slice(0,16)}.png` }),
    });
    const uploadData = await uploadRes.json();
    console.log(`[upload-design] Printful /files HTTP ${uploadRes.status}:`, JSON.stringify(uploadData));

    const designUrl = uploadData.result?.url || tempUrl;

    // Cache the resolved CDN URL so future uploads of the same bytes skip Printful entirely
    const entry = tempImageStore.get(contentHash);
    if (entry) entry.designUrl = designUrl;

    res.json({ designUrl, contentHash });
  } catch (err) {
    console.error('[upload-design] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── MOCKUP GENERATION ────────────────────────────────────────────────────────
// POST /api/mockup
// Body: { productKey, imageUrl, contentHash?, color, size, position: { xPct, yPct, wPct, hPct } }
//   contentHash (optional): sha256 of composited image bytes — used as cache key instead of imageUrl
//   xPct/yPct = top-left corner as fraction of print area (0–1)
//   wPct/hPct = logo size as fraction of print area (0–1)
app.post('/api/mockup', async (req, res) => {
  const { productKey, imageUrl, position, color, size, contentHash } = req.body;
  if (!productKey || !imageUrl)
    return res.status(400).json({ error: 'Missing productKey or imageUrl' });
  if (!process.env.PRINTFUL_API_KEY)
    return res.status(503).json({ error: 'Printful API key not configured' });

  // Default: logo centered at 50% width
  const pos = position || { xPct: 0.25, yPct: 0.25, wPct: 0.50, hPct: 0.50 };
  const sig = [pos.xPct, pos.yPct, pos.wPct, pos.hPct].map(v => Math.round(v * 1000)).join('_');
  // Use content hash when available (composite uploads) — URL changes each run, hash is stable.
  // v3 prefix busts old v2 entries that used the URL.
  const imgKey = contentHash || imageUrl;
  const cacheKey = `v3:${productKey}:${color || ''}:${size || ''}:${imgKey}:${sig}`;

  if (mockupCache.has(cacheKey)) {
    console.log(`[Mockup] CACHE HIT ${cacheKey}`);
    return res.json({ mockupUrl: mockupCache.get(cacheKey) });
  }
  console.log(`[Mockup] CACHE MISS ${cacheKey}`);

  const pfHeaders = {
    'Authorization': `Bearer ${process.env.PRINTFUL_API_KEY}`,
    'X-PF-Store-Id':  process.env.PRINTFUL_STORE_ID || '',
  };

  try {
    const { catalogProductId, catalogVariantId, placementName, area_width, area_height }
      = await getProductPrintInfo(productKey, pfHeaders, color, size);

    // Convert fractions → pixels, clamped strictly inside print area
    const imgW = Math.max(1, Math.min(area_width,  Math.round(area_width  * pos.wPct)));
    const imgH = Math.max(1, Math.min(area_height, Math.round(area_height * pos.hPct)));
    const left = Math.max(0, Math.min(area_width  - imgW, Math.round(area_width  * pos.xPct)));
    const top  = Math.max(0, Math.min(area_height - imgH, Math.round(area_height * pos.yPct)));

    const pfPosition = { area_width, area_height, width: imgW, height: imgH, top, left };
    const proxied = proxyImageUrl(imageUrl);

    console.log(`\n[Mockup] ${productKey} — create-task request:`);
    console.log(`  catalogProductId: ${catalogProductId}  variantId: ${catalogVariantId}  placement: ${placementName}`);
    console.log(`  print area: ${area_width}×${area_height}  logo: ${imgW}×${imgH} at (${left},${top})`);
    console.log(`  image_url: ${proxied}`);

    // Pins: fill all 5 placements so every pin shows the design
    const PIN_PLACEMENTS = ['front', 'first', 'second', 'third', 'fourth'];
    const taskFiles = productKey === 'pins'
      ? PIN_PLACEMENTS.map(p => ({ placement: p, image_url: proxied, position: pfPosition }))
      : [{ placement: placementName, image_url: proxied, position: pfPosition }];

    const taskBody = {
      variant_ids:   [catalogVariantId],
      files:         taskFiles,
      format:        'jpg',
      ...(productKey === 'pins' ? { option_groups: ['Flat'] } : {}),
    };

    const taskRes  = await fetch(`https://api.printful.com/mockup-generator/create-task/${catalogProductId}`, {
      method:  'POST',
      headers: { ...pfHeaders, 'Content-Type': 'application/json' },
      body:    JSON.stringify(taskBody),
    });
    const taskData = await taskRes.json();
    console.log(`[Mockup] ${productKey} — create-task HTTP ${taskRes.status}:`, JSON.stringify(taskData));

    if (!taskRes.ok) {
      const errMsg = taskData.error?.message || JSON.stringify(taskData);
      const retryMatch = errMsg.match(/try again after (\d+) seconds?/i);
      if (retryMatch || taskRes.status === 429) {
        const retryAfter = retryMatch ? parseInt(retryMatch[1]) : 60;
        console.warn(`[Mockup] ${productKey} — rate limited, retry after ${retryAfter}s`);
        return res.status(429).json({ error: errMsg, retryAfter });
      }
      throw new Error(`Mockup task failed: ${errMsg}`);
    }

    const taskKey = taskData.result.task_key;
    console.log(`[Mockup] ${productKey} — task_key: ${taskKey}, polling...`);
    let mockupUrl = null;

    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const pollRes  = await fetch(
        `https://api.printful.com/mockup-generator/task?task_key=${encodeURIComponent(taskKey)}`,
        { headers: pfHeaders },
      );
      const pollData = await pollRes.json();
      const status = pollData.result?.status;
      console.log(`[Mockup] ${productKey} — poll ${i+1}: status=${status}`);
      if (status === 'completed') {
        const primary = pollData.result.mockups?.[0];
        if (productKey === 'mug' && primary?.extra?.length > 0) {
          console.log(`[Mockup] mug extra views:`, JSON.stringify(primary.extra.map(e => ({ title: e.title, option: e.option, option_group: e.option_group }))));
          const front = primary.extra.find(e => /front/i.test(e.title || '') || /front/i.test(e.option || ''));
          mockupUrl = front?.url ?? primary.mockup_url;
          console.log(`[Mockup] mug — selected ${front ? `extra "${front.title}"` : 'primary (no front extra found)'}: ${mockupUrl}`);
        } else {
          mockupUrl = primary?.mockup_url;
        }
        break;
      }
      if (status === 'failed') {
        console.error(`[Mockup] ${productKey} — poll failed response:`, JSON.stringify(pollData));
        throw new Error('Printful mockup generation failed');
      }
    }

    if (!mockupUrl) throw new Error('Mockup generation timed out');

    mockupCache.set(cacheKey, mockupUrl);
    saveMockupCache();
    console.log(`📸 Mockup cached [${productKey}]: ${mockupUrl}`);
    res.json({ mockupUrl });
  } catch (err) {
    console.error(`[Mockup] ${productKey} — ERROR: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── SHIPPING HELPERS ────────────────────────────────────────────────────────
// Non-CONUS US states/territories that Printful treats as international shipping
const NON_CONUS = new Set(['AK','HI','PR','GU','VI','AS','MP','UM']);

function isCONUS(country, state) {
  return country === 'US' && !NON_CONUS.has((state || '').toUpperCase().trim());
}

const shippingRateCache = new Map(); // cacheKey → { rates, expiresAt }

async function getPrintfulShippingRates(recipient, cartItems, pfHeaders) {
  const pfItems = cartItems.flatMap(item => {
    const vid = getVariantId(item.pid, item.size, item.color);
    return vid ? [{ quantity: item.qty || 1, variant_id: parseInt(vid) }] : [];
  });
  if (pfItems.length === 0) return [];

  const body = { recipient, items: pfItems, currency: 'USD', locale: 'en_US' };
  const cacheKey = JSON.stringify(body);
  const cached = shippingRateCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    console.log('[shipping] cache hit');
    return cached.rates;
  }

  const res  = await fetch('https://api.printful.com/shipping/rates', {
    method:  'POST',
    headers: { ...pfHeaders, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  const data = await res.json();
  console.log('[shipping] Printful /shipping/rates HTTP', res.status, JSON.stringify(data).slice(0, 300));
  if (!res.ok) throw new Error(data.error?.message || JSON.stringify(data));

  const rates = data.result || [];
  shippingRateCache.set(cacheKey, { rates, expiresAt: Date.now() + 5 * 60 * 1000 });
  return rates;
}

function cheapestRate(rates) {
  return rates.reduce((a, b) => parseFloat(a.rate) <= parseFloat(b.rate) ? a : b, rates[0]);
}

// We absorb the first $5 of international shipping; customer pays only the excess
const SHIPPING_BASELINE = 5.00;
function customerShippingCost(printfulRate) {
  return Math.max(0, parseFloat(printfulRate) - SHIPPING_BASELINE);
}

// ─── PRODUCTION COST LOOKUP ──────────────────────────────────────────────────
// syncVariantId → { cost, expiresAt } — 24h TTL (prices rarely change)
const productionCostCache = new Map();

async function getProductionCost(syncVariantId, pfHeaders) {
  const cached = productionCostCache.get(syncVariantId);
  if (cached && Date.now() < cached.expiresAt) return cached.cost;

  const svRes  = await fetch(`https://api.printful.com/store/variants/${syncVariantId}`, { headers: pfHeaders });
  const svData = await svRes.json();
  if (!svRes.ok) throw new Error(`store/variants/${syncVariantId}: ${svData.error?.message}`);
  const catalogVarId = svData.result.variant_id;

  const cvRes  = await fetch(`https://api.printful.com/products/variant/${catalogVarId}`, { headers: pfHeaders });
  const cvData = await cvRes.json();
  if (!cvRes.ok) throw new Error(`products/variant/${catalogVarId}: ${cvData.error?.message}`);
  const cost = parseFloat(cvData.result.variant.price);

  productionCostCache.set(syncVariantId, { cost, expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
  return cost;
}

// ─── SHIPPING RATES ENDPOINT ─────────────────────────────────────────────────
app.post('/api/shipping-rates', async (req, res) => {
  const { cart, shipping } = req.body;
  if (!cart || !shipping) return res.status(400).json({ error: 'Missing cart or shipping' });

  if (isCONUS(shipping.country, shipping.state)) {
    return res.json({ isFree: true, cost: 0, label: 'Free' });
  }

  const pfHeaders = {
    Authorization:   `Bearer ${process.env.PRINTFUL_API_KEY}`,
    'X-PF-Store-Id': process.env.PRINTFUL_STORE_ID || '',
  };
  const recipient = {
    address1:     shipping.addr1 || '1 Main St',
    city:         shipping.city  || 'City',
    country_code: shipping.country,
    state_code:   shipping.state || '',
    zip:          shipping.zip   || '',
  };
  try {
    const rates = await getPrintfulShippingRates(recipient, cart, pfHeaders);
    if (!rates.length) {
      return res.status(422).json({ error: 'Printful does not ship to this destination.' });
    }
    const best = cheapestRate(rates);
    const cost = customerShippingCost(best.rate);
    res.json({ isFree: cost === 0, cost, label: best.name });
  } catch (err) {
    console.error('[shipping-rates]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── STRIPE CHECKOUT ──────────────────────────────────────────────────────────
app.post('/api/checkout', async (req, res) => {
  const { cart, shipping, tokenName, tokenSym } = req.body;
  if (!cart || cart.length === 0) return res.status(400).json({ error: 'Empty cart' });

  // ── Content moderation ─────────────────────────────────────────────────────
  const modFlags = checkCart(cart);
  const hardBlocked = modFlags.filter(f => f.result === 'blocked');
  if (hardBlocked.length > 0) {
    console.warn('[checkout] HARD BLOCK — flagged text:', hardBlocked.map(f => `"${f.text}" (${f.category})`).join(', '));
    return res.status(422).json({ error: 'This text is not allowed. Please choose different text.' });
  }
  const needsReview = modFlags.filter(f => f.result === 'review');
  if (needsReview.length > 0) {
    console.warn('[checkout] SOFT REVIEW — flagged text:', needsReview.map(f => `"${f.text}" (${f.category})`).join(', '));
  }
  // ──────────────────────────────────────────────────────────────────────────

  try {
    const lineItems = cart.map(item => ({
      price_data: {
        currency: 'usd',
        product_data: {
          name: `${item.name} — $${tokenSym} ${tokenName}`,
          description: `Size: ${item.size}${item.color ? ` / ${item.color}` : ''}`,
        },
        unit_amount: Math.round(item.price * 100),
      },
      quantity: item.qty,
    }));

    const pfHeaders = {
      Authorization:   `Bearer ${process.env.PRINTFUL_API_KEY}`,
      'X-PF-Store-Id': process.env.PRINTFUL_STORE_ID || '',
    };
    const recipient = {
      address1:     shipping.addr1,
      city:         shipping.city,
      country_code: shipping.country,
      state_code:   shipping.state || '',
      zip:          shipping.zip   || '',
    };

    // Always fetch raw Printful shipping rate — used for both customer charge and profit calc
    let rawPrintfulShipping = 0;
    let shippingLabel = 'Free shipping';
    let shippingCost = 0; // what customer actually pays
    try {
      const rates = await getPrintfulShippingRates(recipient, cart, pfHeaders);
      if (rates.length) {
        const best = cheapestRate(rates);
        rawPrintfulShipping = parseFloat(best.rate);
        shippingLabel = best.name;
        shippingCost = isCONUS(shipping.country, shipping.state)
          ? 0
          : customerShippingCost(rawPrintfulShipping);
      }
    } catch (e) {
      console.warn('[checkout] Could not fetch shipping rate:', e.message);
      rawPrintfulShipping = isCONUS(shipping.country, shipping.state) ? 5 : 12; // conservative estimate
      shippingCost = isCONUS(shipping.country, shipping.state) ? 0 : Math.max(0, rawPrintfulShipping - SHIPPING_BASELINE);
      shippingLabel = 'Shipping & handling';
    }

    // Fetch production cost per item (cached 24h) and run profit guard
    const customerRevenue = cart.reduce((s, i) => s + i.price * (i.qty || 1), 0) + shippingCost;
    let totalProductionCost = 0;
    for (const item of cart) {
      const syncVarId = getVariantId(item.pid, item.size, item.color);
      if (syncVarId) {
        try {
          const cost = await getProductionCost(syncVarId, pfHeaders);
          totalProductionCost += cost * (item.qty || 1);
        } catch (e) {
          console.warn(`[checkout] Could not get production cost for ${item.pid}/${item.size}:`, e.message);
        }
      }
    }
    const profit = customerRevenue - totalProductionCost - rawPrintfulShipping;
    const MIN_PROFIT = 2.00;
    if (profit < MIN_PROFIT) {
      console.warn(
        `[checkout] BLOCKED low-profit order — profit=$${profit.toFixed(2)} ` +
        `revenue=$${customerRevenue.toFixed(2)} pf_prod=$${totalProductionCost.toFixed(2)} ` +
        `pf_ship=$${rawPrintfulShipping.toFixed(2)} ` +
        `country=${shipping.country} state=${shipping.state || ''} ` +
        `cart=${JSON.stringify(cart.map(i => ({ pid: i.pid, size: i.size, qty: i.qty, price: i.price })))}`
      );
      return res.status(422).json({
        error: "Sorry, we're unable to fulfill orders to your location for this cart. Please try a different shipping address or different items.",
      });
    }
    console.log(`[checkout] Profit check OK — profit=$${profit.toFixed(2)} revenue=$${customerRevenue.toFixed(2)} pf_prod=$${totalProductionCost.toFixed(2)} pf_ship=$${rawPrintfulShipping.toFixed(2)}`);

    if (shippingCost > 0) {
      lineItems.push({
        price_data: { currency: 'usd', product_data: { name: shippingLabel }, unit_amount: Math.round(shippingCost * 100) },
        quantity: 1,
      });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items:  lineItems,
      mode:        'payment',
      success_url: `${process.env.FRONTEND_URL}?order=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${process.env.FRONTEND_URL}?order=cancelled`,
      customer_email: shipping.email,
      metadata: {
        cart:              JSON.stringify(cart),
        shipping:          JSON.stringify(shipping),
        token_name:        tokenName,
        token_sym:         tokenSym,
        shipping_cost:     String(shippingCost),
        moderation_flags:  needsReview.length > 0 ? JSON.stringify(needsReview) : '',
      },
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── STRIPE WEBHOOK ───────────────────────────────────────────────────────────
app.post('/api/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    // Re-check moderation from stored metadata (belt-and-suspenders)
    let storedFlags = [];
    try {
      const flagsJson = session.metadata?.moderation_flags;
      storedFlags = flagsJson ? JSON.parse(flagsJson) : [];
    } catch {}

    // Also re-run against the cart (catches any bypass attempt)
    let cart = [];
    try { cart = JSON.parse(session.metadata.cart || '[]'); } catch {}
    const liveFlags = checkCart(cart);
    const hardBlocked = liveFlags.filter(f => f.result === 'blocked');

    if (hardBlocked.length > 0) {
      // This shouldn't reach here (caught at checkout), but hard-block as safety net.
      // Refund and log — no Printful order.
      console.error('[webhook] HARD BLOCK at webhook — auto-refunding session', session.id);
      if (session.payment_intent) {
        stripe.refunds.create({ payment_intent: session.payment_intent })
          .catch(e => console.error('[webhook] Refund failed:', e.message));
      }
    } else if (storedFlags.length > 0 || liveFlags.filter(f => f.result === 'review').length > 0) {
      // Soft review: hold for admin approval
      const allFlags = storedFlags.length > 0 ? storedFlags : liveFlags.filter(f => f.result === 'review');
      const orderId = `pending_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      let shipping = {};
      try { shipping = JSON.parse(session.metadata.shipping || '{}'); } catch {}
      const order = {
        id: orderId,
        stripeSessionId:     session.id,
        stripePaymentIntent: session.payment_intent || null,
        cart,
        shipping,
        tokenName:  session.metadata.token_name || '',
        tokenSym:   session.metadata.token_sym  || '',
        shippingCost: parseFloat(session.metadata.shipping_cost || '0'),
        moderationFlags: allFlags,
        status:     'pending',
        createdAt:  new Date().toISOString(),
      };
      pendingOrders.set(orderId, order);
      savePendingOrders();
      console.warn(`[webhook] Order HELD for review — ${orderId} — ${shipping.email} — flags: ${allFlags.map(f=>`"${f.text}"`).join(', ')}`);
    } else {
      createPrintfulOrder(session).catch(err => console.error('Printful order failed:', err.message));
    }
  }
  res.json({ received: true });
});

// ─── ADMIN ENDPOINTS ─────────────────────────────────────────────────────────

app.get('/api/admin/pending-orders', requireAdmin, (req, res) => {
  const orders = Array.from(pendingOrders.values())
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(orders);
});

app.post('/api/admin/approve-order/:id', requireAdmin, async (req, res) => {
  const order = pendingOrders.get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status !== 'pending') return res.status(409).json({ error: `Order is already ${order.status}` });

  try {
    // Build a synthetic stripe session object that createPrintfulOrder expects
    const fakeSession = {
      id:               order.stripeSessionId,
      payment_intent:   order.stripePaymentIntent,
      customer_email:   order.shipping?.email || '',
      metadata: {
        cart:          JSON.stringify(order.cart),
        shipping:      JSON.stringify(order.shipping),
        token_name:    order.tokenName,
        token_sym:     order.tokenSym,
        shipping_cost: String(order.shippingCost || 0),
      },
    };
    const result = await createPrintfulOrder(fakeSession);
    order.status        = 'approved';
    order.approvedAt    = new Date().toISOString();
    order.printfulOrderId = result?.result?.id || null;
    savePendingOrders();
    console.log(`[admin] APPROVED order ${order.id} → Printful #${order.printfulOrderId}`);
    res.json({ ok: true, printfulOrderId: order.printfulOrderId });
  } catch (err) {
    console.error('[admin] approve failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/reject-order/:id', requireAdmin, async (req, res) => {
  const order = pendingOrders.get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status !== 'pending') return res.status(409).json({ error: `Order is already ${order.status}` });

  try {
    if (order.stripePaymentIntent) {
      await stripe.refunds.create({ payment_intent: order.stripePaymentIntent });
      console.log(`[admin] Refunded payment_intent ${order.stripePaymentIntent}`);
    }
    order.status     = 'rejected';
    order.rejectedAt = new Date().toISOString();
    savePendingOrders();
    console.log(`[admin] REJECTED order ${order.id}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[admin] reject/refund failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── PRINTFUL ORDER ───────────────────────────────────────────────────────────
async function createPrintfulOrder(stripeSession) {
  const cart     = JSON.parse(stripeSession.metadata.cart);
  const shipping = JSON.parse(stripeSession.metadata.shipping);

  const pfHeaders = {
    'Authorization': `Bearer ${process.env.PRINTFUL_API_KEY}`,
    'X-PF-Store-Id':  process.env.PRINTFUL_STORE_ID || '',
  };

  const items = await Promise.all(cart.map(async item => {
    const variantId = getVariantId(item.pid, item.size, item.color);
    if (!variantId) throw new Error(`No variant ID for ${item.pid}/${item.size}/${item.color}`);

    // Build Printful position from saved percentage-based logo position
    let filePosition;
    if (item.logoPos && item.designUrl) {
      try {
        const { area_width, area_height } = await getProductPrintInfo(item.pid, pfHeaders);
        const pos  = item.logoPos;
        const imgW = Math.max(1, Math.min(area_width,  Math.round(area_width  * pos.wPct)));
        const imgH = Math.max(1, Math.min(area_height, Math.round(area_height * pos.hPct)));
        const left = Math.max(0, Math.min(area_width  - imgW, Math.round(area_width  * pos.xPct)));
        const top  = Math.max(0, Math.min(area_height - imgH, Math.round(area_height * pos.yPct)));
        filePosition = { area_width, area_height, width: imgW, height: imgH, top, left };
      } catch {}
    }

    const fileObj = { type: 'default', url: proxyImageUrl(item.designUrl || '') };
    if (filePosition) fileObj.position = filePosition;

    return { sync_variant_id: parseInt(variantId), quantity: item.qty, files: [fileObj] };
  }));

  const order = {
    recipient: {
      name:         `${shipping.fn} ${shipping.ln}`,
      address1:     shipping.addr1,
      address2:     shipping.addr2 || '',
      city:         shipping.city,
      state_code:   shipping.state,
      country_code: shipping.country,
      zip:          shipping.zip,
      email:        shipping.email,
    },
    items,
    retail_costs: { shipping: (parseFloat(stripeSession.metadata.shipping_cost) || 0).toFixed(2) },
  };

  const response = await fetch('https://api.printful.com/orders', {
    method:  'POST',
    headers: { ...pfHeaders, 'Content-Type': 'application/json' },
    body:    JSON.stringify(order),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`Printful error: ${JSON.stringify(result)}`);
  console.log(`✅ Printful order #${result.result?.id} for ${shipping.email}`);
  return result;
}

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 DegenDrip backend  http://localhost:${PORT}`);
  console.log(`   Print area:  GET  /api/printarea/:productKey`);
  console.log(`   Mockup:      POST /api/mockup`);
  console.log(`   Upload:      POST /api/upload-design  (BACKEND_URL=${process.env.BACKEND_URL || 'not set — crop upload disabled'})`);
  console.log(`   Checkout:    POST /api/checkout`);
  console.log(`   Admin:       GET  /admin`);
  console.log(`   Admin API:   GET  /api/admin/pending-orders`);
  console.log(`   Admin API:   POST /api/admin/approve-order/:id`);
  console.log(`   Admin API:   POST /api/admin/reject-order/:id`);
  console.log(`   Moderation:  POST /api/check-text`);
  console.log(`   Mockup cache: ${mockupCache.size} entries`);
  console.log(`   Pending orders: ${pendingOrders.size} loaded\n`);
});
