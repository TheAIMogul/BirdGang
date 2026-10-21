// Offline tests for X Chat entity extraction (dist/lib/xchat/entities.js).
// Run: node tests/xchat-entities-tests.mjs
import assert from 'node:assert/strict';

import { extractEntities, toSdkEntities } from '../dist/lib/xchat/entities.js';

let passed = 0;
let failed = 0;
async function test(name, fn) {
    try {
        await fn();
        passed += 1;
        console.log(`  ok   ${name}`);
    }
    catch (e) {
        failed += 1;
        console.log(`  FAIL ${name}\n       ${e.message}`);
    }
}

const E = (start, end, type) => ({ start, end, type });
const url = (start, end) => E(start, end, 'url');
const email = (start, end) => E(start, end, 'email');
const mention = (start, end) => E(start, end, 'mention');
const hashtag = (start, end) => E(start, end, 'hashtag');
const cashtag = (start, end) => E(start, end, 'cashtag');
const expect = (text, expected) => assert.deepEqual(extractEntities(text), expected, JSON.stringify(text));
const slices = (text) => extractEntities(text).map((e) => text.slice(e.start, e.end));

// URLs

await test('scheme URL keeps path, query and fragment', () => {
    expect('https://example.com/a/b?c=d&e=f#frag', [url(0, 36)]);
});

await test('scheme is case-insensitive and http works', () => {
    expect('HTTP://EXAMPLE.COM/A', [url(0, 20)]);
});

await test('bare domains with a generic TLD link, with or without a path', () => {
    expect('example.com and x.com/foo', [url(0, 11), url(16, 25)]);
    expect('Example.COM', [url(0, 11)]);
});

await test('bare multi-label ccTLD domain links', () => {
    expect('www.foo.co.uk', [url(0, 13)]);
});

await test('bare name.<cc> needs a path or subdomain, except generic-use ccTLDs', () => {
    expect('example.jp', []);
    expect('example.jp/news', [url(0, 15)]);
    expect('www.example.jp', [url(0, 14)]);
    expect('bit.ly t.co', [url(0, 6), url(7, 11)]);
});

await test('file names and abbreviations are not links', () => {
    expect('script.py readme.md node.js v2.0 e.g. i.e. 3.14 John.Do', []);
});

await test('unknown TLD links only with an explicit scheme', () => {
    expect('example.notatld', []);
    expect('https://localhost:3000/x?y=1#z', [url(0, 30)]);
});

await test('bare domain must not run into more host characters after its TLD', () => {
    expect('example.com.foo', [url(0, 11)]);
    expect('foo.com-bar example.comx my_site.com', []);
});

await test('no URL when preceded by a letter, @, $, # or path characters', () => {
    expect('xhttps://example.com', []);
    expect('@example.com', [mention(0, 8)]);
    expect('#example.com', [hashtag(0, 8)]);
    expect('$example.com', []);
    expect('foo/example.com', []);
});

await test('balanced parentheses inside a URL are kept', () => {
    expect('see https://en.wikipedia.org/wiki/Foo_(bar)).', [url(4, 43)]);
});

await test('unbalanced closing ) and ] are excluded', () => {
    expect('(https://example.com/foo)', [url(1, 24)]);
    expect('[https://example.com]', [url(1, 20)]);
    expect('https://x.com/a)b', [url(0, 15)]);
    expect('https://example.com/a[0]', [url(0, 24)]);
});

await test('markdown link target is extracted without the closing paren', () => {
    expect('[link](https://example.com/x)', [url(7, 28)]);
});

await test('trailing punctuation .,!?:;\'" is excluded', () => {
    for (const p of ['.', ',', '!', '?', ':', ';', '\'', '"', '...', '?!']) {
        expect(`Visit https://example.com/path${p}`, [url(6, 30)]);
    }
    expect('www.example.com.', [url(0, 15)]);
});

await test('quoted URL stops at the closing quote', () => {
    expect('"https://example.com/a?b=c"', [url(1, 26)]);
});

await test('port is part of the URL, a bare colon is not', () => {
    expect('example.com:8080/x', [url(0, 18)]);
    expect('example.com: great', [url(0, 11)]);
});

await test('IDN hosts with Unicode letters after a scheme', () => {
    expect('https://bücher.de/katalog', [url(0, 25)]);
    expect('https://пример.рф', [url(0, 17)]);
    expect('https://日本語.jp/パス', [url(0, 15)]);
});

await test('CJK text glued to a URL is not swallowed', () => {
    expect('https://example.com見て', [url(0, 19)]);
    expect('詳細はexample.com', [url(3, 14)]);
});

// Emails

await test('email is reported once, not as a mention or URL', () => {
    expect('john.doe@example.com', [email(0, 20)]);
});

await test('email after mailto: and before punctuation', () => {
    expect('mailto:me@x.io!', [email(7, 14)]);
});

await test('email with multi-label domain', () => {
    expect('user@sub.example.co.uk', [email(0, 22)]);
});

await test('email domain needs a known TLD', () => {
    expect('john@example', []);
    expect('john@example.zz', []);
});

await test('email beats an overlapping mention', () => {
    expect('john-@example.com', [email(0, 17)]);
});

await test('email whose local part looks like a domain is one email', () => {
    expect('john.co@example.com', [email(0, 19)]);
});

await test('URL beats an overlapping email', () => {
    expect('https://user@example.com', [url(0, 24)]);
    expect('https://example.com/contact?to=bob@corp.io', [url(0, 42)]);
});

// Mentions

await test('mentions stop at punctuation', () => {
    expect('ping @a, @b and @c_d!', [mention(5, 7), mention(9, 11), mention(16, 20)]);
});

await test('mention is 1-15 characters; a longer run is not a mention', () => {
    expect('@abcdefghijklmno', [mention(0, 16)]);
    expect('@abcdefghijklmnop', []);
});

await test('no mention after a letter, digit, @ or sigil', () => {
    expect('foo@bar café@user 1@user @@user #@user', []);
});

await test('retweet rule: RT@user and RT:@user are mentions', () => {
    expect('RT@user', [mention(2, 7)]);
    expect('RT:@user', [mention(3, 8)]);
    expect('rt@user', [mention(2, 7)]);
    expect('art@user', []);
});

await test('no mention when followed by @, an accented Latin letter or ://', () => {
    expect('@user@', []);
    expect('@useré', []);
    expect('@usér', []);
    expect('@user://', []);
});

await test('full-width ＠ counts as @', () => {
    expect('＠user', [mention(0, 5)]);
});

await test('mention after a dot or CJK text', () => {
    expect('.@user', [mention(1, 6)]);
    expect('こんにちは@user', [mention(5, 10)]);
});

await test('mention and hashtag inside a URL yield to the URL', () => {
    expect('https://example.com/@user #tag', [url(0, 25), hashtag(26, 30)]);
    expect('https://example.com/#anchor', [url(0, 27)]);
});

// Hashtags

await test('hashtags in many scripts', () => {
    const text = '#hello #日本語 #español #привет #한국어 #ภาษาไทย #hello_world2';
    expect(text, [hashtag(0, 6), hashtag(7, 11), hashtag(12, 20), hashtag(21, 28), hashtag(29, 33), hashtag(34, 42), hashtag(43, 56)]);
    assert.deepEqual(slices(text), text.split(' '));
});

await test('numeric-only hashtag is rejected, letter plus digits is fine', () => {
    expect('#123', []);
    expect('#123 #1st', [hashtag(5, 9)]);
});

await test('HTML entities like &#39; are not hashtags', () => {
    expect('&#39; &#x27; it&#39;s', []);
});

await test('no hashtag after a letter, digit or underscore', () => {
    expect('abc#tag _#tag 1#tag', []);
});

await test('no hashtag when followed by # or ://', () => {
    expect('#foo#bar', []);
    expect('#tag://x', []);
});

await test('ZWNJ and middle dots stay inside a hashtag', () => {
    expect('#col·legi #ハリー・ポッター #می‌خواهم', [hashtag(0, 9), hashtag(10, 19), hashtag(20, 29)]);
});

await test('full-width ＃ counts as #', () => {
    expect('＃タグ', [hashtag(0, 3)]);
});

await test('hashtag after an emoji variation selector; keycap #️⃣ is not a hashtag', () => {
    expect('❤️#love', [hashtag(2, 7)]);
    expect('#️⃣ x', []);
});

await test('astral-plane letters inside a hashtag', () => {
    expect('#𠮷野家', [hashtag(0, 5)]);
});

// Cashtags

await test('cashtags with optional class suffix, any case', () => {
    expect('$TSLA $BRK.A $tsla $BRK_B', [cashtag(0, 5), cashtag(6, 12), cashtag(13, 18), cashtag(19, 25)]);
});

await test('dollar amounts and malformed cashtags are rejected', () => {
    expect('$100 $5B a$B $$TSLA $TOOLONG $TSLA5', []);
});

await test('cashtag inside parens and before a period', () => {
    expect('($TSLA) $AAPL.', [cashtag(1, 6), cashtag(8, 13)]);
});

await test('over-long suffix falls back to the bare cashtag', () => {
    expect('$BRK.ABC', [cashtag(0, 4)]);
});

await test('cashtag inside a URL yields to the URL', () => {
    expect('https://example.com/$TSLA', [url(0, 25)]);
});

// UTF-16 offsets

await test('offsets count UTF-16 code units after emoji', () => {
    expect('👋🏽 @user', [mention(5, 10)]);
});

await test('offsets stay right after flags and astral symbols', () => {
    const text = '🇺🇸 #usa https://x.com/a 𝒳 $TSLA';
    expect(text, [hashtag(5, 9), url(10, 25), cashtag(29, 34)]);
    assert.deepEqual(slices(text), ['#usa', 'https://x.com/a', '$TSLA']);
});

// Overlaps, ordering, input handling

await test('mixed message: every type, sorted by start', () => {
    const text = 'Hi @alice see https://x.com/i/1 #ship $TSLA or mail bob@corp.io';
    expect(text, [mention(3, 9), url(14, 31), hashtag(32, 37), cashtag(38, 43), email(52, 63)]);
    assert.deepEqual(slices(text), ['@alice', 'https://x.com/i/1', '#ship', '$TSLA', 'bob@corp.io']);
});

await test('entities never overlap and stay sorted on messy input', () => {
    const text = '@a@b.com#c $D.E https://x.com/@f#g(h) i@j.io#k RT@l ＃m www.n.co/$o?p=@q';
    const out = extractEntities(text);
    assert.ok(out.length > 0);
    for (let i = 1; i < out.length; i += 1) {
        assert.ok(out[i - 1].end <= out[i].start, `overlap at ${i}: ${JSON.stringify(out)}`);
    }
    for (const e of out) {
        assert.ok(['url', 'email', 'mention', 'hashtag', 'cashtag'].includes(e.type));
        assert.deepEqual(Object.keys(e), ['start', 'end', 'type']);
    }
});

await test('repeated calls give identical results (no regex state leaks)', () => {
    const text = 'see example.com/a and @b #c $D e@f.io';
    const first = extractEntities(text);
    assert.deepEqual(extractEntities(text), first);
    assert.equal(first.length, 5);
});

await test('empty and non-string input returns []', () => {
    for (const input of ['', null, undefined, 42, {}, ['@a']]) {
        assert.deepEqual(extractEntities(input), []);
    }
    expect('hello world', []);
});

await test('toSdkEntities returns [start, end, type] tuples', () => {
    assert.deepEqual(toSdkEntities(extractEntities('hi @a #b')), [[3, 5, 'mention'], [6, 8, 'hashtag']]);
    assert.deepEqual(toSdkEntities([E(0, 4, 'url')]), [[0, 4, 'url']]);
    assert.deepEqual(toSdkEntities([]), []);
    assert.deepEqual(toSdkEntities(null), []);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
