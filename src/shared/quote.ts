/**
 * Is a quote on a page? Used before a maintainer's "cannot open" is accepted (the server reads the
 * page itself: if the passage is there, no browser is needed) and by scripts/verify-seed.ts before
 * seed records are loaded. Copying text across tools changes entities, quotes, dashes and spacing;
 * all of those are made uniform on both sides before comparing. CJK text is compared without the
 * spaces next to it, which pages put in unpredictably (after full-width punctuation, NFKC has made
 * it ASCII).
 */

/** Named entities pages use in running text. Looked up lowercased: the result is lowercased too. */
const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  shy: '', zwsp: '', zwj: '', zwnj: '', lrm: '', rlm: '',
  lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„', prime: '′',
  laquo: '«', raquo: '»', lsaquo: '‹', rsaquo: '›',
  ndash: '–', mdash: '—', minus: '−', hellip: '…', middot: '·', bull: '•',
  pound: '£', euro: '€', yen: '¥', cent: '¢', copy: '©', reg: '®', trade: '™',
  deg: '°', times: '×', divide: '÷', plusmn: '±', frac12: '½', frac14: '¼', frac34: '¾',
  sup2: '²', sup3: '³', sect: '§', para: '¶', iexcl: '¡', iquest: '¿', ordm: 'º', ordf: 'ª',
  aacute: 'á', agrave: 'à', acirc: 'â', auml: 'ä', atilde: 'ã', aring: 'å', aelig: 'æ',
  ccedil: 'ç', eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë',
  iacute: 'í', igrave: 'ì', icirc: 'î', iuml: 'ï', ntilde: 'ñ',
  oacute: 'ó', ograve: 'ò', ocirc: 'ô', ouml: 'ö', otilde: 'õ', oslash: 'ø', oelig: 'œ',
  uacute: 'ú', ugrave: 'ù', ucirc: 'û', uuml: 'ü', yacute: 'ý', yuml: 'ÿ', szlig: 'ß',
};

/** Characters that take no space on a page: zero-width spaces and joiners, direction marks, soft hyphens. */
const INVISIBLE = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

/** Lowercase text with entities decoded, invisible characters dropped, and quotes, dashes, widths and whitespace made uniform. */
export function normalizeQuote(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z][a-z0-9]*);/gi, (match, name: string) => ENTITIES[name.toLowerCase()] ?? match)
    .replace(INVISIBLE, '')
    .normalize('NFKC')
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐‑‒–—]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/ ([,.;:!?)])/g, '$1')
    .replace(/ (?=[\p{Script=Han}\u3000-\u303F])|(?<=[\p{Script=Han}\u3000-\u303F]) /gu, '')
    .trim()
    .toLowerCase();
}

/** Visible text of a page: scripts and styles dropped, tags turned into spaces. */
export const visibleText = (html: string): string =>
  html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ');

/** The raw page with JSON string escapes undone, for pages that ship their text inside JSON. */
export const unescapedHtml = (html: string): string =>
  html
    .replace(/\\u([0-9a-f]{4})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\n/g, ' ')
    .replace(/\\"/g, '"')
    .replace(/<[^>]+>/g, ' ');

/** Whether `quote` appears on the page `html`, in its visible text or inside its embedded JSON. */
export function quoteOnPage(html: string, quote: string): boolean {
  const wanted = normalizeQuote(quote);
  if (!wanted) return false;
  return normalizeQuote(visibleText(html)).includes(wanted) || normalizeQuote(unescapedHtml(html)).includes(wanted);
}
