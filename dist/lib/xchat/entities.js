// Entity extraction for outgoing X Chat messages.
// X's apps render links, @mentions, #hashtags, $cashtags and emails in a chat
// message from entity ranges the sender attaches. This finds them following
// X's twitter-text conventions (implemented from the documented behaviour; no
// third-party code or data) and reports UTF-16 code-unit offsets, so
// text.slice(start, end) is the entity text including its sigil. Pure.

// Two-letter country-code TLDs (ISO 3166-1 codes in the root zone, plus ac, eu, su, uk).
const COUNTRY_TLDS = 'ac ad ae af ag ai al am ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj bm bn bo br bs bt bw by bz '
    + 'ca cc cd cf cg ch ci ck cl cm cn co cr cu cv cw cx cy cz de dj dk dm do dz ec ee eg er es et eu fi fj fk fm fo fr '
    + 'ga gd ge gf gg gh gi gl gm gn gp gq gr gs gt gu gw gy hk hm hn hr ht hu id ie il im in io iq ir is it je jm jo jp '
    + 'ke kg kh ki km kn kp kr kw ky kz la lb lc li lk lr ls lt lu lv ly ma mc md me mg mh mk ml mm mn mo mp mq mr ms mt '
    + 'mu mv mw mx my mz na nc ne nf ng ni nl no np nr nu nz om pa pe pf pg ph pk pl pm pn pr ps pt pw py qa re ro rs ru '
    + 'rw sa sb sc sd se sg sh si sk sl sm sn so sr ss st su sv sx sy sz tc td tf tg th tj tk tl tm tn to tr tt tv tw tz '
    + 'ua ug uk us uy uz va vc ve vg vi vn vu wf ws ye yt za zm zw';
// Generic TLDs commonly seen on X. File-extension lookalikes (.zip, .mov) are left out on purpose.
const GENERIC_TLDS = 'com net org edu gov mil int info biz name pro mobi asia aero coop jobs museum travel tel xyz '
    + 'app dev page blog shop store online site website tech space club live news media social cloud digital '
    + 'agency design studio email software solutions company academy global wiki ltd inc llc';
const TLDS = new Set(`${COUNTRY_TLDS} ${GENERIC_TLDS}`.split(' '));
// Country codes used like generic TLDs: a bare `name.<cc>` with no path still links.
// Any other `name.<cc>` needs a path or a subdomain (`example.jp/x`, `www.example.jp`), as in twitter-text.
const GENERIC_CC = new Set(['co', 'tv', 'io', 'ai', 'me', 'gg', 'ly', 'fm']);

// Regex building blocks (all used with the `u` flag).
const LATIN = '\\p{Script=Latin}\\u0300-\\u036F';
const ACCENTED = '\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02AF\\u0300-\\u036F\\u1E00-\\u1EFF';
const AT = '@\\uFF20';
const HASH = '#\\uFF03';
const ASCII_LABEL = '[A-Za-z0-9]+(?:-+[A-Za-z0-9]+)*';
const ASCII_HOST = `${ASCII_LABEL}(?:\\.${ASCII_LABEL})+`;
// After a scheme, a host label is all Latin script or all other scripts, so text
// glued to a host (`https://example.com見て`) is not swallowed into it.
const LATIN_LABEL = `[${LATIN}\\p{Nd}]+(?:[-_]+[${LATIN}\\p{Nd}]+)*`;
const OTHER_CHAR = '(?:[^\\P{L}\\p{Script=Latin}]|[\\p{M}\\p{Nd}])';
const IDN_LABEL = `(?:${LATIN_LABEL}|${OTHER_CHAR}+(?:[-_]+${OTHER_CHAR}+)*)`;
const URL_LETTERS = '\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u024F\\u0300-\\u036F\\u0400-\\u04FF\\u1E00-\\u1EFF';
const HASHTAG_CHARS = '\\p{L}\\p{M}\\p{Nd}_\\u200C\\u200D\\u00B7\\u30FB\\u05BE\\u05F3\\u05F4\\u0F0B\\u0F0C'
    + '\\u3003\\u301C\\uFF5E\\u309B\\u309C\\u30A0\\uA67E';

// Scheme URL (any host), or a bare ASCII host in group 1 whose TLD is checked in code.
const URL_RE = new RegExp(
    `(?<![${LATIN}0-9${AT}$${HASH}])[Hh][Tt][Tt][Pp][Ss]?:\\/\\/(?:[\\w.~%+-]+(?::[\\w.~%+-]*)?@)?${IDN_LABEL}(?:\\.${IDN_LABEL})*`
    + `|(?<![${LATIN}0-9${AT}$${HASH}_./-])(${ASCII_HOST})`,
    'gu',
);
// Port, path, query and fragment, matched from the end of the host.
const URL_TAIL_RE = new RegExp(`(?::\\d+)?(?:[/?#][A-Za-z0-9\\-._~!$&'()*+,;=:@%/?#\\[\\]|${URL_LETTERS}]*)?`, 'y');
// Characters a URL may end with; anything else at the end (.,!?:;'" etc.) is trimmed.
const URL_END = new RegExp(`[A-Za-z0-9${URL_LETTERS}/\\-_+=#&)\\]]`);
// A bare host or email domain must not run straight into one of these after its TLD.
const HOST_STOP = new RegExp(`[${LATIN}\\p{Nd}${AT}+\\-]`, 'u');
const EMAIL_RE = new RegExp(`(?<![${LATIN}0-9_%+.\\-])[A-Za-z0-9_%+\\-]+(?:\\.[A-Za-z0-9_%+\\-]+)*@(${ASCII_HOST})`, 'gu');
// `RT@user` / `RT:@user` are mentions (retweet convention); otherwise no letter, digit or sigil before.
const MENTION_RE = new RegExp(
    `(?:(?<=(?:^|[^${LATIN}0-9_+~.\\-])[Rr][Tt]:?)|(?<![${LATIN}0-9_!#$%&*${AT}]))`
    + `[${AT}][A-Za-z0-9_]{1,15}(?![A-Za-z0-9_${AT}${ACCENTED}]|:\\/\\/)`,
    'gu',
);
// Needs a letter or mark (`#123` is not a hashtag); `&#39;` and the #️⃣ keycap are not hashtags.
const HASHTAG_RE = new RegExp(
    `(?:(?<=[\\uFE0E\\uFE0F])|(?<![&${HASHTAG_CHARS}]))[${HASH}](?![\\uFE0F\\u20E3])`
    + `(?=[${HASHTAG_CHARS}]*[\\p{L}\\p{M}])[${HASHTAG_CHARS}]+(?![${HASHTAG_CHARS}${HASH}]|:\\/\\/)`,
    'gu',
);
const CASHTAG_RE = /(?<![\p{L}\p{N}\p{M}_$])\$[A-Za-z]{1,6}(?:[._][A-Za-z]{1,2})?(?![\p{L}\p{N}\p{M}])/gu;
const SIGIL_PATTERNS = [[MENTION_RE, 'mention'], [HASHTAG_RE, 'hashtag'], [CASHTAG_RE, 'cashtag']];
const RANK = { url: 0, email: 1 };

// Longest run of leading host labels that ends in a known TLD, or null.
function knownTld(host) {
    const labels = host.split('.');
    for (let i = labels.length - 1; i > 0; i -= 1) {
        const tld = labels[i].toLowerCase();
        if (TLDS.has(tld)) {
            return { length: labels.slice(0, i + 1).join('.').length, labels: i + 1, tld };
        }
    }
    return null;
}

// End offset of the URL whose host ends at `pos`: takes port/path/query/fragment,
// stops at the first unbalanced ) or ], then drops trailing punctuation.
function urlEnd(text, pos) {
    URL_TAIL_RE.lastIndex = pos;
    const tail = URL_TAIL_RE.exec(text)[0];
    let cut = tail.length;
    let parens = 0;
    let brackets = 0;
    for (let i = 0; i < tail.length; i += 1) {
        const ch = tail[i];
        if (ch === '(') {
            parens += 1;
        }
        else if (ch === '[') {
            brackets += 1;
        }
        else if ((ch === ')' && parens-- === 0) || (ch === ']' && brackets-- === 0)) {
            cut = i;
            break;
        }
    }
    while (cut > 0 && !URL_END.test(tail[cut - 1])) {
        cut -= 1;
    }
    return pos + cut;
}

function findUrls(text, out) {
    URL_RE.lastIndex = 0;
    let m;
    while ((m = URL_RE.exec(text)) !== null) {
        const start = m.index;
        let hostEnd = start + m[0].length;
        let needsPath = false;
        if (m[1] !== undefined) {
            const tld = knownTld(m[1]);
            if (!tld || HOST_STOP.test(text.charAt(start + tld.length))) {
                continue; // lastIndex already sits at the end of the rejected host
            }
            hostEnd = start + tld.length;
            needsPath = tld.labels === 2 && tld.tld.length === 2 && !GENERIC_CC.has(tld.tld);
        }
        const end = urlEnd(text, hostEnd);
        URL_RE.lastIndex = needsPath && end === hostEnd ? start + m[0].length : end;
        if (!needsPath || end > hostEnd) {
            out.push({ start, end, type: 'url' });
        }
    }
}

function findEmails(text, out) {
    for (const m of text.matchAll(EMAIL_RE)) {
        const tld = knownTld(m[1]);
        const end = m.index + m[0].length - m[1].length + (tld ? tld.length : 0);
        if (tld && !HOST_STOP.test(text.charAt(end))) {
            out.push({ start: m.index, end, type: 'email' });
        }
    }
}

// Entities in `text` as [{ start, end, type }] sorted by start; type is
// 'url' | 'email' | 'mention' | 'hashtag' | 'cashtag'. Offsets are UTF-16 code
// units, end exclusive. Overlaps resolve URL > email > earliest mention/hashtag/cashtag.
export function extractEntities(text) {
    if (typeof text !== 'string' || text === '') {
        return [];
    }
    const found = [];
    findUrls(text, found);
    findEmails(text, found);
    for (const [re, type] of SIGIL_PATTERNS) {
        for (const m of text.matchAll(re)) {
            found.push({ start: m.index, end: m.index + m[0].length, type });
        }
    }
    found.sort((a, b) => (RANK[a.type] ?? 2) - (RANK[b.type] ?? 2) || a.start - b.start);
    const kept = [];
    for (const e of found) {
        if (kept.every((k) => e.end <= k.start || e.start >= k.end)) {
            kept.push(e);
        }
    }
    return kept.sort((a, b) => a.start - b.start);
}

// [{ start, end, type }] -> [[start, end, type]], the tuple form chat-xdk's
// encryptMessage({ entities }) takes.
export function toSdkEntities(entities) {
    return Array.isArray(entities) ? entities.map((e) => [e.start, e.end, e.type]) : [];
}
