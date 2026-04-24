require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const Jimp       = require('jimp');
const fetch      = require('node-fetch');
const stripe     = require('stripe')(process.env.STRIPE_SECRET_KEY);
const fs         = require('fs');
const path       = require('path');
const Redis      = require('ioredis');
const { Resend } = require('resend');
const { checkText, checkCart } = require('./moderation');
const { randomBytes, createHash } = require('crypto');

// ─── Redis client ─────────────────────────────────────────────────────────────
const redis = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 2 })
  : null;
if (redis) {
  redis.on('connect', () => console.log('Redis connected'));
  redis.on('error',   e  => console.error('Redis error:', e.message));
} else {
  console.warn('[redis] REDIS_URL not set — order data will use in-memory fallback');
}

const app  = express();
const PORT = process.env.PORT || 3001;

// ─── Checkout-to-webhook bridge (Redis, 24h TTL) ──────────────────────────────
// Stores full cart + shipping between /api/checkout and the Stripe webhook.
const orderStoreFallback = new Map();

async function orderStoreSet(orderId, data) {
  const json = JSON.stringify(data);
  if (redis) {
    try { await redis.setex(`order:${orderId}`, 86400, json); return; } catch (e) {
      console.error('[orderStore] Redis setex failed, using fallback:', e.message);
    }
  }
  orderStoreFallback.set(orderId, data);
}

async function orderStoreGet(orderId) {
  if (redis) {
    try {
      const raw = await redis.get(`order:${orderId}`);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      console.error('[orderStore] Redis get failed, checking fallback:', e.message);
    }
  }
  return orderStoreFallback.get(orderId) || null;
}

async function orderStoreDel(orderId) {
  if (redis) {
    try { await redis.del(`order:${orderId}`); } catch (e) {
      console.error('[orderStore] Redis del failed:', e.message);
    }
  }
  orderStoreFallback.delete(orderId);
}

// ─── Review order store (Redis, 30-day TTL) ──────────────────────────────────
// ALL paid orders land here with status "pending_review" for manual approval.
// Indexed by orderId; a list `ro:idx` keeps newest-first insertion order.
const REVIEW_ORDER_TTL    = 30 * 24 * 60 * 60; // 30 days
const reviewOrderFallback = new Map();

async function reviewOrderSave(order) {
  const json = JSON.stringify(order);
  if (redis) {
    try {
      await redis.setex(`ro:${order.orderId}`, REVIEW_ORDER_TTL, json);
      await redis.lrem('ro:idx', 0, order.orderId); // remove existing entry (update case)
      await redis.lpush('ro:idx', order.orderId);
      await redis.ltrim('ro:idx', 0, 999);
      return;
    } catch (e) { console.error('[reviewOrder] Redis save failed:', e.message); }
  }
  reviewOrderFallback.set(order.orderId, order);
}

async function reviewOrderGet(orderId) {
  if (redis) {
    try {
      const raw = await redis.get(`ro:${orderId}`);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { console.error('[reviewOrder] Redis get failed:', e.message); }
  }
  return reviewOrderFallback.get(orderId) || null;
}

async function reviewOrderUpdate(orderId, updates) {
  const order = await reviewOrderGet(orderId);
  if (!order) return null;
  const updated = { ...order, ...updates };
  await reviewOrderSave(updated);
  return updated;
}

async function reviewOrderList(statusFilter) {
  let orders = [];
  if (redis) {
    try {
      const ids = await redis.lrange('ro:idx', 0, 999);
      if (ids.length > 0) {
        const pipeline = redis.pipeline();
        for (const id of ids) pipeline.get(`ro:${id}`);
        const results = await pipeline.exec();
        for (const [err, raw] of results) {
          if (!err && raw) { try { orders.push(JSON.parse(raw)); } catch {} }
        }
      }
    } catch (e) {
      console.error('[reviewOrder] Redis list failed:', e.message);
      orders = Array.from(reviewOrderFallback.values());
    }
  } else {
    orders = Array.from(reviewOrderFallback.values());
  }
  orders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return statusFilter ? orders.filter(o => o.status === statusFilter) : orders;
}

// ─── Admin auth middleware ────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const adminPw = process.env.ADMIN_PASSWORD;
  if (!adminPw) return res.status(503).json({ error: 'ADMIN_PASSWORD not configured' });
  const auth  = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (token !== adminPw) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ─── Email (Resend) ──────────────────────────────────────────────────────────
const resend      = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const FROM_EMAIL  = process.env.FROM_EMAIL  || 'no-reply@degendrip.net';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'steadydesk.ai@gmail.com';

function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const emailWrap = (body) => `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0f0f14">
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f0f14;color:#e0e0e0;padding:40px 24px;max-width:560px;margin:0 auto">
  <div style="margin-bottom:28px"><span style="font-size:18px;font-weight:700;color:#fff;letter-spacing:-.01em">DegenDrip</span></div>
  ${body}
  <div style="margin-top:36px;padding-top:16px;border-top:1px solid #2a2a3a;font-size:12px;color:#555">
    Questions? Reply to this email. &nbsp;&middot;&nbsp; <a href="https://degendrip.net" style="color:#555">degendrip.net</a>
  </div>
</div></body></html>`;

async function sendEmail({ to, subject, html }) {
  if (!resend) { console.warn('[email] Resend not configured, skipping:', subject); return; }
  try {
    await resend.emails.send({ from: `DegenDrip <${FROM_EMAIL}>`, to, subject, html });
    console.log(`[email] Sent "${subject}" → ${to}`);
  } catch (e) { console.error('[email] Failed:', subject, e.message); }
}

function sendOrderReceived(order) {
  return sendEmail({
    to: order.customerEmail,
    subject: 'Your DegenDrip order is in review',
    html: emailWrap(`
      <h2 style="font-size:20px;color:#fff;margin:0 0 12px">Order received ✓</h2>
      <p style="color:#aaa;line-height:1.6;margin:0 0 16px">Thanks for your order! We review every order before production to make sure it prints cleanly. Review usually takes under 24 hours.</p>
      <p style="color:#aaa;line-height:1.6;margin:0 0 24px">You'll get another email once it's approved and in production.</p>
      <div style="background:#1a1a24;border:1px solid #2a2a3a;border-radius:8px;padding:16px">
        <div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Order ID</div>
        <div style="font-family:monospace;color:#ddd;font-size:13px">${escHtml(order.orderId)}</div>
      </div>`),
  });
}

function sendOrderInProduction(order) {
  return sendEmail({
    to: order.customerEmail,
    subject: 'Your DegenDrip order is being made',
    html: emailWrap(`
      <h2 style="font-size:20px;color:#44ff88;margin:0 0 12px">Order approved 🎉</h2>
      <p style="color:#aaa;line-height:1.6;margin:0 0 24px">Good news — your order is approved and now in production. We'll email you tracking info once it ships.</p>
      <div style="background:#1a1a24;border:1px solid #2a2a3a;border-radius:8px;padding:16px">
        <div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Order ID</div>
        <div style="font-family:monospace;color:#ddd;font-size:13px">${escHtml(order.orderId)}</div>
      </div>`),
  });
}

function sendOrderRejected(order) {
  return sendEmail({
    to: order.customerEmail,
    subject: 'Your DegenDrip order was refunded',
    html: emailWrap(`
      <h2 style="font-size:20px;color:#ff6666;margin:0 0 12px">Order refunded</h2>
      <p style="color:#aaa;line-height:1.6;margin:0 0 16px">We weren't able to fulfill your order.</p>
      <div style="background:#2a1414;border:1px solid #4a2020;border-radius:8px;padding:16px;margin-bottom:20px">
        <div style="font-size:11px;color:#776060;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Reason</div>
        <div style="color:#ffaaaa;line-height:1.5">${escHtml(order.rejectionReason || 'Order could not be fulfilled')}</div>
      </div>
      <p style="color:#aaa;line-height:1.6;margin:0 0 24px">Your payment has been fully refunded and should appear in 5–10 business days.</p>
      <div style="background:#1a1a24;border:1px solid #2a2a3a;border-radius:8px;padding:16px">
        <div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Order ID</div>
        <div style="font-family:monospace;color:#ddd;font-size:13px">${escHtml(order.orderId)}</div>
      </div>`),
  });
}

function sendOrderShipped(order, trackingUrl, carrier) {
  return sendEmail({
    to: order.customerEmail,
    subject: 'Your DegenDrip order has shipped',
    html: emailWrap(`
      <h2 style="font-size:20px;color:#fff;margin:0 0 12px">Your order is on the way 📦</h2>
      <div style="background:#1a1a24;border:1px solid #2a2a3a;border-radius:8px;padding:20px">
        ${trackingUrl ? `<div style="margin-bottom:16px">
          <div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Tracking</div>
          <a href="${escHtml(trackingUrl)}" style="color:#60b0ff;word-break:break-all;font-size:14px">${escHtml(trackingUrl)}</a>
        </div>` : ''}
        ${carrier ? `<div style="margin-bottom:16px">
          <div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Carrier</div>
          <div style="color:#ddd;font-size:14px">${escHtml(carrier)}</div>
        </div>` : ''}
        <div>
          <div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Order ID</div>
          <div style="font-family:monospace;color:#ddd;font-size:13px">${escHtml(order.orderId)}</div>
        </div>
      </div>`),
  });
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
function proxyImageUrl(url) {
  if (url.startsWith('https://wsrv.nl/') || url.startsWith('http://wsrv.nl/')) {
    try {
      const src = new URL(url).searchParams.get('url');
      if (src) return `https://wsrv.nl/?url=${encodeURIComponent(src)}&output=png&w=1800`;
    } catch {}
  }
  return `https://wsrv.nl/?url=${encodeURIComponent(url)}&output=png&w=1800`;
}

// Fetch, compute and cache everything needed for a product's print area.
async function getProductPrintInfo(productKey, pfHeaders, color, size) {
  const cacheKey = `${productKey}:${color || ''}:${size || ''}`;
  if (printAreaInfoCache.has(cacheKey)) return printAreaInfoCache.get(cacheKey);

  let syncVariantId;
  if (color) {
    const variantMap = buildVariantMap()[productKey] || {};
    const exactMatch = size ? Object.entries(variantMap).find(([k]) => k === `${size}|${color}`) : null;
    const colorMatch = Object.entries(variantMap).find(([k]) => k.split('|')[1] === color);
    syncVariantId = exactMatch?.[1] ?? colorMatch?.[1] ?? REPRESENTATIVE_SYNC_VARIANTS[productKey]?.();
  } else {
    syncVariantId = REPRESENTATIVE_SYNC_VARIANTS[productKey]?.();
  }
  if (!syncVariantId) throw new Error(`No sync variant configured for: ${productKey}${color ? ` (${color})` : ''}`);

  const svRes  = await fetch(`https://api.printful.com/sync/variant/${syncVariantId}`, { headers: pfHeaders });
  const svData = await svRes.json();
  if (!svRes.ok) throw new Error(`Sync variant lookup failed: ${svData.error?.message}`);

  const catalogVariantId  = svData.result.sync_variant.variant_id;
  const catalogProductId  = svData.result.sync_variant.product.product_id;
  const svFiles           = svData.result.sync_variant.files ?? [];
  const variantPreviewUrl = svFiles.find(f => f.type === 'preview')?.preview_url
                         ?? svFiles[0]?.preview_url
                         ?? null;

  const pfRes  = await fetch(`https://api.printful.com/mockup-generator/printfiles/${catalogProductId}`, { headers: pfHeaders });
  const pfData = await pfRes.json();

  const variantPf = pfData.result?.variant_printfiles?.[0]?.placements ?? {};
  let placementName = 'front';
  if (!variantPf.front) {
    if (variantPf.front_large) placementName = 'front_large';
    else if (Object.keys(variantPf).length > 0) placementName = Object.keys(variantPf)[0];
  }
  const pfId      = variantPf[placementName];
  const printfile = pfData.result?.printfiles?.find(p => p.printfile_id === pfId)
                 ?? pfData.result?.printfiles?.[0];
  const area_width  = printfile?.width  ?? 1800;
  const area_height = printfile?.height ?? 2400;

  let template = null;
  try {
    const tmRes  = await fetch(`https://api.printful.com/mockup-generator/templates/${catalogProductId}`, { headers: pfHeaders });
    const tmData = await tmRes.json();
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

  const catalogPhotoUrl = await getCatalogProductPhoto(catalogProductId, pfHeaders);

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
  exposedHeaders: ['x-converted-from'],
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

// ─── Image proxy ─────────────────────────────────────────────────────────────
const sharp = require('sharp');

app.get('/api/proxy-image', async (req, res) => {
  const url = req.query.url;
  if (!url || !url.startsWith('http')) return res.status(400).json({ error: 'Missing or invalid url' });

  const cacheKey = `imgproxy:${createHash('sha256').update(url).digest('hex').slice(0, 40)}`;
  const metaKey  = `${cacheKey}:cf`;

  if (redis) {
    try {
      const [cachedB64, convertedFrom] = await Promise.all([
        redis.get(cacheKey),
        redis.get(metaKey),
      ]);
      if (cachedB64) {
        const buf = Buffer.from(cachedB64, 'base64');
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        if (convertedFrom) res.setHeader('x-converted-from', convertedFrom);
        return res.send(buf);
      }
    } catch (e) { console.warn('[proxy-image] Redis read error:', e.message); }
  }

  let origBuffer;
  try {
    const origRes = await fetch(url, { timeout: 15000 });
    if (!origRes.ok) return res.status(502).json({ error: `Upstream ${origRes.status} for ${url}` });
    origBuffer = await origRes.buffer();
  } catch (e) {
    return res.status(502).json({ error: `Fetch failed: ${e.message}` });
  }

  const sig          = origBuffer.slice(0, 6).toString('binary');
  const isGif        = sig.startsWith('GIF87a') || sig.startsWith('GIF89a');
  const isWebpCont   = sig.slice(0, 4) === 'RIFF' && origBuffer.length > 12 && origBuffer.slice(8, 12).toString('binary') === 'WEBP';
  const isAnimWebp   = isWebpCont && origBuffer.indexOf(Buffer.from('ANIM')) !== -1;

  let outBuffer, convertedFrom = null;
  try {
    if (isGif || isAnimWebp) {
      outBuffer    = await sharp(origBuffer, { animated: false }).png().toBuffer();
      convertedFrom = isGif ? 'gif' : 'webp';
      console.log(`[proxy-image] Converted animated ${convertedFrom} → PNG: ${url.slice(0, 80)}`);
    } else {
      outBuffer = await sharp(origBuffer).png().toBuffer();
    }
  } catch (e) {
    console.warn('[proxy-image] sharp failed, serving raw:', e.message);
    outBuffer = origBuffer;
  }

  if (redis) {
    try {
      await redis.setex(cacheKey, 86400, outBuffer.toString('base64'));
      if (convertedFrom) await redis.setex(metaKey, 86400, convertedFrom);
    } catch (e) { console.warn('[proxy-image] Redis write error:', e.message); }
  }

  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  if (convertedFrom) res.setHeader('x-converted-from', convertedFrom);
  res.send(outBuffer);
});

// ─── Text moderation check ────────────────────────────────────────────────────
app.post('/api/check-text', (req, res) => {
  const { text } = req.body;
  if (typeof text !== 'string') return res.status(400).json({ error: 'Missing text' });
  res.json(checkText(text));
});

// ─── Stock status ─────────────────────────────────────────────────────────────
const stockCache = new Map();
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
    const ourSizes   = new Set(Object.keys(variantMap).map(k => k.includes('|') ? k.split('|')[0] : k));
    const normSizeMap = new Map([...ourSizes].map(s => [s.toLowerCase(), s]));

    const sizeStatusMap  = {};
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
    const r = Math.round(corners.reduce((s, c) => s + c.r, 0) / corners.length);
    const g = Math.round(corners.reduce((s, c) => s + c.g, 0) / corners.length);
    const b = Math.round(corners.reduce((s, c) => s + c.b, 0) / corners.length);
    res.json({ color: '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('') });
  } catch {
    res.json({ color: '#ffffff' });
  }
});

// ─── PRINT AREA INFO ──────────────────────────────────────────────────────────
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
const tempImageStore = new Map();
setInterval(() => {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [hash, entry] of tempImageStore)
    if (entry.created < cutoff) tempImageStore.delete(hash);
}, 60_000);

app.get('/api/tmp/:uuid', (req, res) => {
  const entry = tempImageStore.get(req.params.uuid);
  if (!entry) return res.status(404).send('Not found');
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.send(entry.buffer);
});

app.post('/api/upload-design', async (req, res) => {
  const { base64 } = req.body;
  if (!base64) return res.status(400).json({ error: 'Missing base64' });

  try {
    const b64          = base64.replace(/^data:image\/\w+;base64,/, '');
    const buffer       = Buffer.from(b64, 'base64');
    const contentHash  = createHash('sha256').update(buffer).digest('hex');

    const existing = tempImageStore.get(contentHash);
    if (existing?.designUrl) {
      console.log(`[upload-design] CACHE HIT hash=${contentHash.slice(0,12)}… — reusing ${existing.designUrl}`);
      return res.json({ designUrl: existing.designUrl, contentHash });
    }

    tempImageStore.set(contentHash, { buffer, created: Date.now(), designUrl: null });
    console.log(`[upload-design] New image ${(buffer.length / 1024).toFixed(0)} KB → hash=${contentHash.slice(0,12)}…`);

    const backendUrl = (
      process.env.BACKEND_URL ||
      (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '')
    ).replace(/\/$/, '');
    if (!backendUrl) {
      console.warn('[upload-design] BACKEND_URL not set — cannot make image public for Printful');
      return res.json({ designUrl: null });
    }

    const tempUrl = `${backendUrl}/api/tmp/${contentHash}`;
    if (!process.env.PRINTFUL_API_KEY) return res.json({ designUrl: tempUrl, contentHash });

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
    const entry = tempImageStore.get(contentHash);
    if (entry) entry.designUrl = designUrl;

    res.json({ designUrl, contentHash });
  } catch (err) {
    console.error('[upload-design] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── MOCKUP GENERATION ────────────────────────────────────────────────────────
app.post('/api/mockup', async (req, res) => {
  const { productKey, imageUrl, position, color, size, contentHash } = req.body;
  if (!productKey || !imageUrl)
    return res.status(400).json({ error: 'Missing productKey or imageUrl' });
  if (!process.env.PRINTFUL_API_KEY)
    return res.status(503).json({ error: 'Printful API key not configured' });

  const pos = position || { xPct: 0.25, yPct: 0.25, wPct: 0.50, hPct: 0.50 };
  const sig = [pos.xPct, pos.yPct, pos.wPct, pos.hPct].map(v => Math.round(v * 1000)).join('_');
  const imgKey   = contentHash || imageUrl;
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

    const imgW = Math.max(1, Math.min(area_width,  Math.round(area_width  * pos.wPct)));
    const imgH = Math.max(1, Math.min(area_height, Math.round(area_height * pos.hPct)));
    const left = Math.max(0, Math.min(area_width  - imgW, Math.round(area_width  * pos.xPct)));
    const top  = Math.max(0, Math.min(area_height - imgH, Math.round(area_height * pos.yPct)));

    const pfPosition = { area_width, area_height, width: imgW, height: imgH, top, left };
    const proxied    = proxyImageUrl(imageUrl);

    console.log(`\n[Mockup] ${productKey} — create-task request:`);
    console.log(`  catalogProductId: ${catalogProductId}  variantId: ${catalogVariantId}  placement: ${placementName}`);
    console.log(`  print area: ${area_width}×${area_height}  logo: ${imgW}×${imgH} at (${left},${top})`);
    console.log(`  image_url: ${proxied}`);

    const PIN_PLACEMENTS = ['front', 'first', 'second', 'third', 'fourth'];
    const taskFiles = productKey === 'pins'
      ? PIN_PLACEMENTS.map(p => ({ placement: p, image_url: proxied, position: pfPosition }))
      : [{ placement: placementName, image_url: proxied, position: pfPosition }];

    const taskBody = {
      variant_ids: [catalogVariantId],
      files:       taskFiles,
      format:      'jpg',
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
      const errMsg     = taskData.error?.message || JSON.stringify(taskData);
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
      const status   = pollData.result?.status;
      console.log(`[Mockup] ${productKey} — poll ${i+1}: status=${status}`);
      if (status === 'completed') {
        const primary = pollData.result.mockups?.[0];
        if (productKey === 'mug' && primary?.extra?.length > 0) {
          const front = primary.extra.find(e => /front/i.test(e.title || '') || /front/i.test(e.option || ''));
          mockupUrl   = front?.url ?? primary.mockup_url;
        } else {
          mockupUrl = primary?.mockup_url;
        }
        break;
      }
      if (status === 'failed') throw new Error('Printful mockup generation failed');
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
const NON_CONUS = new Set(['AK','HI','PR','GU','VI','AS','MP','UM']);

function isCONUS(country, state) {
  return country === 'US' && !NON_CONUS.has((state || '').toUpperCase().trim());
}

const shippingRateCache = new Map();

async function getPrintfulShippingRates(recipient, cartItems, pfHeaders) {
  const pfItems = cartItems.flatMap(item => {
    const vid = getVariantId(item.pid, item.size, item.color);
    return vid ? [{ quantity: item.qty || 1, variant_id: parseInt(vid) }] : [];
  });
  if (pfItems.length === 0) return [];

  const body     = { recipient, items: pfItems, currency: 'USD', locale: 'en_US' };
  const cacheKey = JSON.stringify(body);
  const cached   = shippingRateCache.get(cacheKey);
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

const SHIPPING_BASELINE = 5.00;
function customerShippingCost(printfulRate) {
  return Math.max(0, parseFloat(printfulRate) - SHIPPING_BASELINE);
}

// ─── PRODUCTION COST LOOKUP ──────────────────────────────────────────────────
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

  const modFlags    = checkCart(cart);
  const hardBlocked = modFlags.filter(f => f.result === 'blocked');
  if (hardBlocked.length > 0) {
    console.warn('[checkout] HARD BLOCK — flagged text:', hardBlocked.map(f => `"${f.text}" (${f.category})`).join(', '));
    return res.status(422).json({ error: 'This text is not allowed. Please choose different text.' });
  }
  const needsReview = modFlags.filter(f => f.result === 'review');
  if (needsReview.length > 0) {
    console.warn('[checkout] SOFT REVIEW — flagged text:', needsReview.map(f => `"${f.text}" (${f.category})`).join(', '));
  }

  try {
    const lineItems = cart.map(item => ({
      price_data: {
        currency:     'usd',
        product_data: {
          name:        `${item.name} — $${tokenSym} ${tokenName}`,
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

    let rawPrintfulShipping = 0, shippingLabel = 'Free shipping', shippingCost = 0;
    try {
      const rates = await getPrintfulShippingRates(recipient, cart, pfHeaders);
      if (rates.length) {
        const best          = cheapestRate(rates);
        rawPrintfulShipping = parseFloat(best.rate);
        shippingLabel       = best.name;
        shippingCost        = isCONUS(shipping.country, shipping.state)
          ? 0
          : customerShippingCost(rawPrintfulShipping);
      }
    } catch (e) {
      console.warn('[checkout] Could not fetch shipping rate:', e.message);
      rawPrintfulShipping = isCONUS(shipping.country, shipping.state) ? 5 : 12;
      shippingCost        = isCONUS(shipping.country, shipping.state) ? 0 : Math.max(0, rawPrintfulShipping - SHIPPING_BASELINE);
      shippingLabel       = 'Shipping & handling';
    }

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
    const profit    = customerRevenue - totalProductionCost - rawPrintfulShipping;
    const MIN_PROFIT = 2.00;
    if (profit < MIN_PROFIT) {
      console.warn(
        `[checkout] BLOCKED low-profit order — profit=$${profit.toFixed(2)} ` +
        `revenue=$${customerRevenue.toFixed(2)} pf_prod=$${totalProductionCost.toFixed(2)} ` +
        `pf_ship=$${rawPrintfulShipping.toFixed(2)} country=${shipping.country} state=${shipping.state || ''} ` +
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

    const orderId       = `order_${randomBytes(8).toString('hex')}`;
    const cartForStore  = cart.map(({ thumbnailUrl: _t, ...rest }) => rest);
    await orderStoreSet(orderId, {
      cart:            cartForStore,
      shipping,
      tokenName:       tokenName || '',
      tokenSym:        tokenSym  || '',
      shippingCost,
      moderationFlags: needsReview,
      createdAt:       new Date().toISOString(),
    });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items:   lineItems,
      mode:         'payment',
      success_url:  `${process.env.FRONTEND_URL}?order=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:   `${process.env.FRONTEND_URL}?order=cancelled`,
      customer_email: shipping.email,
      metadata: {
        order_id:      orderId,
        token_name:    tokenName  || '',
        token_sym:     tokenSym   || '',
        shipping_cost: String(shippingCost),
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
    handleCompletedSession(session).catch(err =>
      console.error('[webhook] handleCompletedSession failed:', err.message)
    );
  }
  res.json({ received: true });
});

async function handleCompletedSession(session) {
  const orderId = session.metadata?.order_id;

  let orderData = orderId ? await orderStoreGet(orderId) : null;
  if (!orderData) {
    console.warn('[webhook] orderStore miss for', orderId, '— falling back to metadata');
    let cart = [], shipping = {};
    try { cart     = JSON.parse(session.metadata.cart     || '[]'); } catch {}
    try { shipping = JSON.parse(session.metadata.shipping || '{}'); } catch {}
    orderData = {
      cart, shipping,
      tokenName:       session.metadata.token_name    || '',
      tokenSym:        session.metadata.token_sym     || '',
      shippingCost:    parseFloat(session.metadata.shipping_cost || '0'),
      moderationFlags: (() => { try { return JSON.parse(session.metadata.moderation_flags || '[]'); } catch { return []; } })(),
    };
  }

  const { cart, shipping, tokenName, tokenSym, shippingCost, moderationFlags = [] } = orderData;

  // Belt-and-suspenders hard-block re-check; auto-refund if triggered
  const liveFlags   = checkCart(cart);
  const hardBlocked = liveFlags.filter(f => f.result === 'blocked');
  if (hardBlocked.length > 0) {
    console.error('[webhook] HARD BLOCK — auto-refunding session', session.id);
    if (session.payment_intent) {
      stripe.refunds.create({ payment_intent: session.payment_intent })
        .catch(e => console.error('[webhook] Refund failed:', e.message));
    }
    if (orderId) await orderStoreDel(orderId);
    return;
  }

  const reviewFlags = moderationFlags.length > 0
    ? moderationFlags
    : liveFlags.filter(f => f.result === 'review');

  // ALL orders (clean or flagged) go to manual review
  const reviewOrderId = `ro_${randomBytes(8).toString('hex')}`;
  const total         = cart.reduce((s, i) => s + (i.price || 0) * (i.qty || 1), 0)
                      + (parseFloat(shippingCost) || 0);

  const reviewOrder = {
    orderId:               reviewOrderId,
    customerEmail:         shipping.email || '',
    customerName:          `${shipping.fn || ''} ${shipping.ln || ''}`.trim(),
    items:                 cart,
    shippingAddress:       shipping,
    total,
    stripeSessionId:       session.id,
    stripePaymentIntentId: session.payment_intent || null,
    moderationFlags:       reviewFlags,
    status:                'pending_review',
    createdAt:             new Date().toISOString(),
    reviewedAt:            null,
    rejectionReason:       null,
    printfulOrderId:       null,
    tokenName:             tokenName || '',
    tokenSym:              tokenSym  || '',
    shippingCost:          parseFloat(shippingCost) || 0,
  };

  await reviewOrderSave(reviewOrder);
  if (orderId) await orderStoreDel(orderId);
  console.log(`[webhook] Order saved for review: ${reviewOrderId} — ${shipping.email}${reviewFlags.length ? ` — ${reviewFlags.length} flag(s)` : ''}`);

  sendOrderReceived(reviewOrder).catch(e => console.error('[email]', e.message));

  const backendUrl = (process.env.BACKEND_URL || process.env.FRONTEND_URL || 'https://degendrip.net').replace(/\/$/, '');
  sendEmail({
    to:      ADMIN_EMAIL,
    subject: `New order needs review — ${reviewOrderId}`,
    html:    emailWrap(`
      <h2 style="font-size:18px;color:#fff;margin:0 0 12px">New order needs review</h2>
      <p style="color:#aaa;margin:0 0 20px">${escHtml(reviewOrder.customerEmail)} &nbsp;·&nbsp; $${total.toFixed(2)}${reviewFlags.length ? ` &nbsp;·&nbsp; <span style="color:#ffaaaa">${reviewFlags.length} moderation flag(s)</span>` : ''}</p>
      <a href="${backendUrl}/admin" style="display:inline-block;background:#4a7fff;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;font-size:14px">Review order →</a>
      <div style="margin-top:20px;background:#1a1a24;border:1px solid #2a2a3a;border-radius:8px;padding:16px">
        <div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Order ID</div>
        <div style="font-family:monospace;color:#ddd;font-size:13px">${escHtml(reviewOrderId)}</div>
      </div>`),
  }).catch(e => console.error('[email admin]', e.message));
}

// ─── ADMIN ENDPOINTS ──────────────────────────────────────────────────────────

// GET /api/admin/orders?status=pending_review|in_production|rejected|shipped
app.get('/api/admin/orders', requireAdmin, async (req, res) => {
  try {
    const orders = await reviewOrderList(req.query.status || null);
    res.json(orders);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/orders/:orderId
app.get('/api/admin/orders/:orderId', requireAdmin, async (req, res) => {
  try {
    const order = await reviewOrderGet(req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json(order);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/orders/:orderId/approve → Printful → in_production → email customer
app.post('/api/admin/orders/:orderId/approve', requireAdmin, async (req, res) => {
  try {
    const order = await reviewOrderGet(req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'pending_review') return res.status(409).json({ error: `Order is already ${order.status}` });

    const pfResult       = await createPrintfulOrder({
      cart:            order.items,
      shipping:        order.shippingAddress,
      tokenName:       order.tokenName,
      tokenSym:        order.tokenSym,
      shippingCost:    order.shippingCost || 0,
      stripeSessionId: order.stripeSessionId,
    });
    const printfulOrderId = pfResult?.result?.id || null;

    // Store Printful→review mapping so the shipping webhook can find this order
    if (printfulOrderId && redis) {
      redis.setex(`ro:pf:${printfulOrderId}`, REVIEW_ORDER_TTL, order.orderId)
        .catch(e => console.error('[reviewOrder] pf mapping failed:', e.message));
    }

    const updated = await reviewOrderUpdate(req.params.orderId, {
      status:          'in_production',
      reviewedAt:      new Date().toISOString(),
      printfulOrderId,
    });

    console.log(`[admin] APPROVED ${order.orderId} → Printful #${printfulOrderId}`);
    sendOrderInProduction(updated).catch(e => console.error('[email]', e.message));
    res.json({ ok: true, printfulOrderId });
  } catch (e) {
    console.error('[admin] approve failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/orders/:orderId/reject  body: { reason }
app.post('/api/admin/orders/:orderId/reject', requireAdmin, async (req, res) => {
  try {
    const order = await reviewOrderGet(req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'pending_review') return res.status(409).json({ error: `Order is already ${order.status}` });

    const reason = (req.body.reason || '').trim() || 'Order could not be fulfilled';

    if (order.stripePaymentIntentId) {
      try {
        await stripe.refunds.create({ payment_intent: order.stripePaymentIntentId });
        console.log(`[admin] Refunded PI ${order.stripePaymentIntentId}`);
      } catch (stripeErr) {
        const alreadyRefunded = stripeErr.code === 'charge_already_refunded'
          || /already been refunded/i.test(stripeErr.message || '');
        if (alreadyRefunded) {
          console.warn(`[admin] PI ${order.stripePaymentIntentId} already refunded — treating as success`);
        } else {
          throw stripeErr;
        }
      }
    }

    const updated = await reviewOrderUpdate(req.params.orderId, {
      status:          'rejected',
      reviewedAt:      new Date().toISOString(),
      rejectionReason: reason,
    });

    console.log(`[admin] REJECTED ${order.orderId} — "${reason}"`);
    sendOrderRejected(updated).catch(e => console.error('[email]', e.message));
    res.json({ ok: true });
  } catch (e) {
    console.error('[admin] reject failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── PRINTFUL SHIPPING WEBHOOK ────────────────────────────────────────────────
// Configure in Printful dashboard → Settings → Webhooks → package_shipped
// URL: https://degendripn-backend-production.up.railway.app/api/printful-webhook
app.post('/api/printful-webhook', async (req, res) => {
  res.json({ received: true }); // ack immediately
  const event = req.body;
  if (event.type !== 'package_shipped') return;
  try {
    const pfOrderId = event.data?.order?.id;
    const shipment  = event.data?.shipment;
    if (!pfOrderId) return;

    // Look up review order by Printful order ID
    let roId = null;
    if (redis) roId = await redis.get(`ro:pf:${pfOrderId}`).catch(() => null);
    if (!roId) {
      const all   = await reviewOrderList();
      const found = all.find(o => String(o.printfulOrderId) === String(pfOrderId));
      if (found) roId = found.orderId;
    }
    if (!roId) {
      console.warn('[printful-webhook] No review order found for PF order', pfOrderId);
      return;
    }

    const trackingUrl = shipment?.tracking_url || null;
    const carrier     = shipment?.carrier       || null;

    const updated = await reviewOrderUpdate(roId, {
      status:      'shipped',
      shippedAt:   new Date().toISOString(),
      trackingUrl,
      carrier,
    });

    console.log(`[printful-webhook] Order ${roId} shipped — tracking: ${trackingUrl}`);
    if (updated) sendOrderShipped(updated, trackingUrl, carrier).catch(e => console.error('[email]', e.message));
  } catch (e) {
    console.error('[printful-webhook] Error:', e.message);
  }
});

// ─── PRINTFUL ORDER ───────────────────────────────────────────────────────────
async function createPrintfulOrder({ cart, shipping, tokenName, tokenSym, shippingCost, stripeSessionId }) {
  // Safety: reject before hitting Printful if any design URL is still local
  for (const item of cart) {
    const url = item.designUrl || '';
    if (url.startsWith('blob:') || url.startsWith('data:')) {
      throw new Error(`Order contains a local blob/data URL for item "${item.pid}" — design was not uploaded before checkout`);
    }
    if (/wsrv\.nl/i.test(url) && /blob%3A/i.test(url)) {
      throw new Error(`Order contains a wsrv-wrapped blob URL for item "${item.pid}" — design was not uploaded before checkout`);
    }
  }

  const pfHeaders = {
    'Authorization': `Bearer ${process.env.PRINTFUL_API_KEY}`,
    'X-PF-Store-Id':  process.env.PRINTFUL_STORE_ID || '',
  };

  const items = await Promise.all(cart.map(async item => {
    const variantId = getVariantId(item.pid, item.size, item.color);
    if (!variantId) throw new Error(`No variant ID for ${item.pid}/${item.size}/${item.color}`);

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
    retail_costs: { shipping: (parseFloat(shippingCost) || 0).toFixed(2) },
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

// ─── PRINTFUL WEBHOOK REGISTRATION ───────────────────────────────────────────
async function registerPrintfulWebhook() {
  const REDIS_FLAG = 'printful:webhook:registered';
  if (redis) {
    try {
      const already = await redis.get(REDIS_FLAG);
      if (already) { console.log('[printful-webhook] Already registered (cached), skipping'); return; }
    } catch (e) { console.warn('[printful-webhook] Redis check failed:', e.message); }
  }

  if (!process.env.PRINTFUL_API_KEY) {
    console.warn('[printful-webhook] PRINTFUL_API_KEY not set, skipping registration');
    return;
  }

  try {
    const res  = await fetch('https://api.printful.com/webhooks', {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${process.env.PRINTFUL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url:   'https://degendripn-backend-production.up.railway.app/api/printful-webhook',
        types: ['package_shipped'],
      }),
    });
    const data = await res.json();
    console.log('[printful-webhook] Registration response:', JSON.stringify(data));

    const msg = data?.error?.message || '';
    if (res.ok || /already|configured|exists/i.test(msg)) {
      console.log(res.ok ? '[printful-webhook] Printful webhook registered' : '[printful-webhook] Printful webhook already configured');
      if (redis) {
        redis.setex(REDIS_FLAG, 7 * 24 * 60 * 60, '1')
          .catch(e => console.warn('[printful-webhook] Redis flag write failed:', e.message));
      }
    } else {
      console.error('[printful-webhook] Registration failed:', JSON.stringify(data));
    }
  } catch (e) {
    console.error('[printful-webhook] Registration error:', e.message);
  }
}

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 DegenDrip backend  http://localhost:${PORT}`);
  console.log(`   Admin:          GET  /admin`);
  console.log(`   Admin API:      GET  /api/admin/orders[?status=...]`);
  console.log(`   Admin API:      GET  /api/admin/orders/:id`);
  console.log(`   Admin API:      POST /api/admin/orders/:id/approve`);
  console.log(`   Admin API:      POST /api/admin/orders/:id/reject`);
  console.log(`   Stripe webhook: POST /api/webhook`);
  console.log(`   PF webhook:     POST /api/printful-webhook`);
  console.log(`   Checkout:       POST /api/checkout`);
  console.log(`   Mockup:         POST /api/mockup`);
  console.log(`   Mockup cache: ${mockupCache.size} entries\n`);
  registerPrintfulWebhook().catch(e => console.error('[printful-webhook] Startup registration threw:', e.message));
});
