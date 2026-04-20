'use strict';

// ─── Normalisation ────────────────────────────────────────────────────────────
// Collapse leetspeak, zero-width junk, and common character substitutions so
// patterns match e.g. "n1gg3r", "f@gg0t", "k1ke" without separate variants.
function normalize(text) {
  return text
    .toLowerCase()
    // Strip zero-width / invisible Unicode
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff\u00ad]/g, '')
    // Leetspeak substitutions
    .replace(/[4@]/g, 'a')
    .replace(/[3€]/g, 'e')
    .replace(/[1!|ı]/g, 'i')
    .replace(/[0]/g, 'o')
    .replace(/\$/g, 's')
    .replace(/\+/g, 't')
    .replace(/9/g, 'g')
    // Collapse repeated chars (niiigger → niiger) but keep doubles (nigg)
    .replace(/(.)\1{2,}/g, '$1$1')
    .trim();
}

// Strip everything non-alpha — catches space-padded evasions like "n i g g e r"
function stripSpaces(text) {
  return text.toLowerCase().replace(/[^a-z]/g, '');
}

// ─── HARD BLOCK ───────────────────────────────────────────────────────────────
// Immediately rejected. Customer sees a generic "not allowed" message.
const HARD_BLOCK = [
  // ── Racial slurs ─────────────────────────────────────────────────────────
  // N-word (normalised + space-stripped)
  { cat: 'racial_slur',
    test: (r, n) =>
      /\bni+g+e?r[sz]?\b/.test(n) || /\bni+g+a[sz]?\b/.test(n) ||
      /nig+e?r/.test(stripSpaces(r)) || /nig+a/.test(stripSpaces(r)) },

  // Anti-Asian: ch*nk, g**k
  { cat: 'racial_slur',
    test: (r, n) => /\bch[i]nk\b/.test(n) || /\bgo+k\b/.test(n) || /\bchink/.test(stripSpaces(r)) },

  // Anti-Hispanic: sp*c, w*tb*ck
  { cat: 'racial_slur',
    test: (r, n) => /\bsp[i]cks?\b/.test(n) || /\bwetbacks?\b/.test(n) },

  // ── Anti-LGBTQ+ slurs ─────────────────────────────────────────────────────
  { cat: 'lgbtq_slur',
    test: (r, n) => /\bfagg?[ot]*s?\b/.test(n) || /\bfagg?s?\b/.test(n) },
  { cat: 'lgbtq_slur',
    test: (r, n) => /\btrannis?\b/.test(n) || /\btrannies\b/.test(n) },

  // ── Anti-religious / ethnic slurs ────────────────────────────────────────
  { cat: 'religious_slur',
    test: (r, n) => /\bki+kes?\b/.test(n) },         // k-slur
  { cat: 'racial_slur',
    test: (r, n) => /\bsandnigger\b/.test(stripSpaces(r)) || /\bsandnig\b/.test(n) },
  { cat: 'racial_slur',
    test: (r, n) => /\bz?ip+perhead\b/.test(n) },    // anti-Asian
  { cat: 'racial_slur',
    test: (r, n) => /\bcra?cker\b/.test(n) && /\bstupid|ugly|die|kill\b/.test(n) }, // contextual

  // ── Self-harm encouragement ───────────────────────────────────────────────
  { cat: 'self_harm',
    test: (r, n) =>
      /\bkys\b/.test(n) ||
      /kill\s+your\s*self/.test(n) ||
      /neck\s+your\s*self/.test(n) ||
      /hang\s+your\s*self/.test(n) ||
      /end\s+your\s*(own\s+)?life/.test(n) ||
      /drink\s+bleach/.test(n) },

  // ── Direct violence threats ───────────────────────────────────────────────
  { cat: 'threat',
    test: (r, n) =>
      /shoot\s+up/.test(n) ||
      /bomb\s+the\s+\w/.test(n) ||
      /kill\s+all\s+(the\s+)?\w/.test(n) ||
      /death\s+to\s+all/.test(n) ||
      /\bslay\s+all\s+\w/.test(n) },

  // ── CSAM (zero tolerance) ─────────────────────────────────────────────────
  { cat: 'csam',
    test: (r, n) =>
      /child\s*(porn|sex|nude|nud[ei])/i.test(r) ||
      /kiddie\s*porn/i.test(r) ||
      /loli\s*porn/i.test(r) ||
      /pedo\s*porn/i.test(r) },

  // ── Explicit pornographic ────────────────────────────────────────────────
  { cat: 'explicit',
    test: (r, n) =>
      /cumshot/.test(n) ||
      /cocksucker/.test(n) ||
      /\bjizz\b/.test(n) },
];

// ─── SOFT REVIEW ──────────────────────────────────────────────────────────────
// Order held for manual approval. Customer pays and receives confirmation.
const SOFT_REVIEW = [
  // Political figures + threatening / violent context
  { cat: 'political_figure',
    reason: 'Political figure name combined with violent or criminal language',
    test: (r, n) => {
      const figure = /\b(trump|biden|obama|harris|clinton|pelosi|aoc|desantis|maga)\b/.test(n);
      const violent = /\b(kill|shoot|hang|dead|execute|arrest|prison|pedo|rapist|traitor|evil|burn|destroy)\b/.test(n);
      return figure && violent;
    } },

  // Hate symbols
  { cat: 'hate_symbol',
    reason: 'Contains a hate symbol or neo-Nazi reference',
    test: (r, n) =>
      /\b88\b/.test(n) && /\bheil|nazi|white\s+power|reich\b/.test(n) ||
      /\bsieg\s+heil\b/.test(n) ||
      /\bwhite\s+power\b/.test(n) ||
      /\b1488\b/.test(n) },

  // Drug slang / dealing
  { cat: 'drug_reference',
    reason: 'Drug name or dealing slang',
    test: (r, n) =>
      /\b(cocaine|heroin|meth(amphetamine)?|fentanyl|oxy(cotin|contin)?|xanax|percocet)\b/.test(n) },

  // Graphic violence (not threat but imagery)
  { cat: 'graphic_violence',
    reason: 'Graphic violent imagery',
    test: (r, n) =>
      /\b(torture|dismember|behead|lynch|decapitat|genocide)\b/.test(n) },

  // Borderline slurs — context-dependent
  { cat: 'borderline_language',
    reason: 'Word that may be acceptable in some contexts but is often offensive',
    test: (r, n) =>
      /\bretard(ed)?\b/.test(n) ||
      /\bspook\b/.test(n) },
];

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Check a single text string.
 * @returns {{ result: 'ok' }}
 *        | {{ result: 'blocked', category: string }}
 *        | {{ result: 'review',  category: string, reason: string }}
 */
function checkText(text) {
  if (!text || typeof text !== 'string') return { result: 'ok' };
  const norm = normalize(text);
  const raw  = text;

  for (const rule of HARD_BLOCK) {
    try { if (rule.test(raw, norm)) return { result: 'blocked', category: rule.cat }; }
    catch { /* malformed regex safety */ }
  }
  for (const rule of SOFT_REVIEW) {
    try { if (rule.test(raw, norm)) return { result: 'review', category: rule.cat, reason: rule.reason }; }
    catch {}
  }
  return { result: 'ok' };
}

/**
 * Check every textElement across all cart items.
 * @returns Array of flags — only entries where result !== 'ok'
 */
function checkCart(cart) {
  const flags = [];
  if (!Array.isArray(cart)) return flags;
  for (let i = 0; i < cart.length; i++) {
    const item = cart[i];
    if (!Array.isArray(item.textElements)) continue;
    for (const el of item.textElements) {
      if (!el?.text) continue;
      const check = checkText(el.text);
      if (check.result !== 'ok') {
        flags.push({ itemIndex: i, pid: item.pid, text: el.text, ...check });
      }
    }
  }
  return flags;
}

module.exports = { checkText, checkCart };
