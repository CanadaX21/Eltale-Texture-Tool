// The Texture Tool in the browser: every texture of the original ROM as a PNG with the same name and pixels as export_textures.py, and edited
// PNGs back into a new copy of the ROM with the same bytes as import_textures.py. No DOM, so a test can run this in Deno against the Python tool.
// Which textures exist comes from texture_table.js, because the ROM is one exact file. See docs/TECHNICAL.md.
(function (root) {
    'use strict';
    const T = root.TEXTURE_TABLE;
    const records = T.rows.map(r => Object.fromEntries(T.head.map((h, i) => [h, r[i]])));
    for (const t of records) if (t.pal < 0) t.pal = null;

    const hex6 = v => v.toString(16).toUpperCase().padStart(6, '0');
    const TAIL = /_([0-9A-F]{6})_(\d+)x(\d+)_([a-z]+)(\d+)(?:_pal([0-9A-F]{6}))?\.png$/;
    const TO5 = v => Math.floor((v * 31 + 127) / 255);
    const key5 = (r, g, b, a) => [TO5(r), TO5(g), TO5(b), a >= 128 ? 1 : 0];
    const rowBytes = t => t.stride || (t.w * t.siz + 7) >> 3;
    const u16 = (rom, o) => rom[o] << 8 | rom[o + 1];
    const c5 = v => Math.floor(v * 255 / 31);

    function pal5551(rom, o, n) {
        const out = [];
        for (let i = 0; i < n; i++) {
            const v = u16(rom, o + 2 * i);
            out.push([c5(v >> 11 & 31), c5(v >> 6 & 31), c5(v >> 1 & 31), v & 1 ? 255 : 0]);
        }
        return out;
    }

    function palFor(rom, t) {
        const P = pal5551(rom, t.pal, t.pal_n);
        if (t.clear0) P[0] = [P[0][0], P[0][1], P[0][2], 0];
        return P;
    }

    /** The picture as the exporter writes it: RGBA, w x h. */
    function decode(rom, t) {
        const { w, h, fmt, siz } = t, row = rowBytes(t), px = new Uint8Array(w * h * 4);
        let P = null;
        if (fmt === 'CI') {
            if (t.pal !== null) P = palFor(rom, t);
            else { P = []; for (let c = 0; c < t.pal_n; c++) { const g = Math.floor(c * 255 / (t.pal_n - 1)); P.push([g, g, g, 255]); } }  // no palette found: grey ramp, flagged in the manifest
        }
        const put = (i, r, g, b, a) => { px[i * 4] = r; px[i * 4 + 1] = g; px[i * 4 + 2] = b; px[i * 4 + 3] = a; };
        for (let y = 0; y < h; y++) {
            const o = t.rom + y * row;
            for (let x = 0; x < w; x++) {
                const i = y * w + x;
                if (siz === 4) {
                    const b = rom[o + (x >> 1)], v = x & 1 ? b & 15 : b >> 4;
                    if (fmt === 'CI') { const c = P[v]; put(i, c[0], c[1], c[2], c[3]); }
                    else if (fmt === 'I') put(i, v * 17, v * 17, v * 17, 255);
                    else { const g = Math.floor((v >> 1) * 255 / 7); put(i, g, g, g, v & 1 ? 255 : 0); }
                } else if (siz === 8) {
                    const v = rom[o + x];
                    if (fmt === 'CI') { const c = P[v]; put(i, c[0], c[1], c[2], c[3]); }
                    else if (fmt === 'I') put(i, v, v, v, 255);
                    else put(i, (v >> 4) * 17, (v >> 4) * 17, (v >> 4) * 17, (v & 15) * 17);
                } else if (siz === 16) {
                    const a = rom[o + 2 * x], b = rom[o + 2 * x + 1];
                    if (fmt === 'RGBA') { const v = a << 8 | b; put(i, c5(v >> 11 & 31), c5(v >> 6 & 31), c5(v >> 1 & 31), v & 1 ? 255 : 0); }
                    else put(i, a, a, a, b);
                } else put(i, rom[o + 4 * x], rom[o + 4 * x + 1], rom[o + 4 * x + 2], rom[o + 4 * x + 3]);
            }
        }
        if (t.opaque) for (let i = 3; i < px.length; i += 4) px[i] = 255;
        return px;
    }

    const rawOf = (rom, t) => rom.subarray(t.rom, t.rom + rowBytes(t) * t.h);

    // ---------------------------------------------------------------- MD5, for the manifest and for finding identical art
    const MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
    const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);
    function md5(bytes) {
        const n = bytes.length, full = ((n + 8) >> 6) + 1, m = new Uint8Array(full * 64);
        m.set(bytes);
        m[n] = 0x80;
        const bits = n * 8;
        for (let i = 0; i < 4; i++) m[full * 64 - 8 + i] = (bits >>> (8 * i)) & 255;
        m[full * 64 - 4] = Math.floor(n / 2 ** 29) & 255;
        let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
        const dv = new DataView(m.buffer);
        for (let o = 0; o < m.length; o += 64) {
            let a = a0, b = b0, c = c0, d = d0;
            for (let i = 0; i < 64; i++) {
                let f, g;
                if (i < 16) { f = (b & c) | (~b & d); g = i; }
                else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
                else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
                else { f = c ^ (b | ~d); g = (7 * i) % 16; }
                const s = MD5_S[(i >> 4) * 4 + (i & 3)], x = (a + f + MD5_K[i] + dv.getUint32(o + g * 4, true)) | 0;
                a = d; d = c; c = b;
                b = (b + ((x << s) | (x >>> (32 - s)))) | 0;
            }
            a0 = (a0 + a) | 0; b0 = (b0 + b) | 0; c0 = (c0 + c) | 0; d0 = (d0 + d) | 0;
        }
        let s = '';
        for (const v of [a0, b0, c0, d0]) for (let i = 0; i < 4; i++) s += ((v >>> (8 * i)) & 255).toString(16).padStart(2, '0');
        return s;
    }

    // ---------------------------------------------------------------- the N64 header checksum (CIC-6102 seed), n64crc.py
    function fixCrc(rom) {
        let t1, t2, t3, t4, t5, t6;
        t1 = t2 = t3 = t4 = t5 = t6 = 0xF8CA4DDC;
        const dv = new DataView(rom.buffer, rom.byteOffset, rom.byteLength);
        for (let o = 0x1000; o < 0x101000; o += 4) {
            const d = dv.getUint32(o);
            const sum = (t6 + d) >>> 0;
            if (sum < t6) t4 = (t4 + 1) >>> 0;
            t6 = sum;
            t3 = (t3 ^ d) >>> 0;
            const s = d & 0x1F, r = s ? ((d << s) | (d >>> (32 - s))) >>> 0 : d;
            t5 = (t5 + r) >>> 0;
            t2 = (t2 > d ? t2 ^ r : t2 ^ t6 ^ d) >>> 0;
            t1 = (t1 + ((t5 ^ d) >>> 0)) >>> 0;
        }
        dv.setUint32(0x10, (t6 ^ t4 ^ t3) >>> 0);
        dv.setUint32(0x14, (t5 ^ t2 ^ t1) >>> 0);
    }

    // ---------------------------------------------------------------- PNG: any file an image editor writes, read without a canvas (a canvas would change colours under transparency)
    async function stream(data, Kind, format) {
        const s = new Blob([data]).stream().pipeThrough(new Kind(format));
        return new Uint8Array(await new Response(s).arrayBuffer());
    }
    const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
    function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

    async function readPng(bytes) {
        const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
        if (bytes.length < 33 || SIG.some((v, i) => bytes[i] !== v)) throw new Error('not a PNG file');
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let w = 0, h = 0, depth = 0, type = 0, interlace = 0, plte = null, trns = null;
        const idat = [];
        for (let o = 8; o + 8 <= bytes.length;) {
            const n = dv.getUint32(o), kind = String.fromCharCode(bytes[o + 4], bytes[o + 5], bytes[o + 6], bytes[o + 7]), d = bytes.subarray(o + 8, o + 8 + n);
            if (kind === 'IHDR') { w = dv.getUint32(o + 8); h = dv.getUint32(o + 12); depth = d[8]; type = d[9]; interlace = d[12]; }
            else if (kind === 'PLTE') plte = d;
            else if (kind === 'tRNS') trns = d;
            else if (kind === 'IDAT') idat.push(d);
            else if (kind === 'IEND') break;
            o += 12 + n;
        }
        const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
        if (!channels || !w || !h || !idat.length) throw new Error('not a PNG this tool can read');
        let raw;
        try { raw = await stream(new Blob(idat), DecompressionStream, 'deflate'); } catch { throw new Error('its image data is damaged'); }
        const out = new Uint8Array(w * h * 4), bpp = Math.max(1, (channels * depth) >> 3);
        let at = 0;
        const pass = (x0, y0, dx, dy) => {
            const pw = Math.ceil((w - x0) / dx), ph = Math.ceil((h - y0) / dy);
            if (pw <= 0 || ph <= 0) return;
            const stride = Math.ceil(pw * channels * depth / 8);
            let prev = new Uint8Array(stride);
            for (let py = 0; py < ph; py++) {
                const f = raw[at++], line = raw.slice(at, at + stride);
                at += stride;
                if (line.length < stride) throw new Error('its image data is cut short');
                for (let i = 0; i < stride; i++) {
                    const a = i >= bpp ? line[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
                    let add = 0;
                    if (f === 1) add = a; else if (f === 2) add = b; else if (f === 3) add = (a + b) >> 1;
                    else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
                    line[i] = (line[i] + add) & 255;
                }
                prev = line;
                for (let px = 0; px < pw; px++) {
                    const i = ((y0 + py * dy) * w + x0 + px * dx) * 4;
                    const sample = c => {     // the sample as stored, and at 8 bits
                        if (depth === 8) return line[px * channels + c];
                        if (depth === 16) return line[(px * channels + c) * 2];
                        const bit = px * depth;
                        return (line[bit >> 3] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
                    };
                    if (type === 3) {
                        const v = sample(0);
                        if (!plte || v * 3 + 2 >= plte.length) throw new Error('it uses a colour outside its palette');
                        out[i] = plte[v * 3]; out[i + 1] = plte[v * 3 + 1]; out[i + 2] = plte[v * 3 + 2];
                        out[i + 3] = trns && v < trns.length ? trns[v] : 255;
                    } else if (type === 0 || type === 4) {
                        const v = sample(0), g = depth < 8 ? Math.floor(v * 255 / ((1 << depth) - 1)) : v;
                        out[i] = out[i + 1] = out[i + 2] = g;
                        if (type === 4) out[i + 3] = sample(1);
                        else {
                            const key = trns ? (trns[0] << 8 | trns[1]) : -1;
                            const full = depth === 16 ? line[px * 2] << 8 | line[px * 2 + 1] : v;
                            out[i + 3] = full === key ? 0 : 255;
                        }
                    } else {
                        out[i] = sample(0); out[i + 1] = sample(1); out[i + 2] = sample(2);
                        if (type === 6) out[i + 3] = sample(3);
                        else {
                            let clear = !!trns;
                            if (trns) for (let c = 0; c < 3; c++) {
                                const key = trns[c * 2] << 8 | trns[c * 2 + 1], o = (px * 3 + c) * (depth >> 3);
                                const full = depth === 16 ? line[o] << 8 | line[o + 1] : line[o];
                                if (full !== key) clear = false;
                            }
                            out[i + 3] = clear ? 0 : 255;
                        }
                    }
                }
            }
        };
        if (interlace) for (const p of [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]) pass(...p);
        else pass(0, 0, 1, 1);
        return { w, h, px: out };
    }

    async function writePng(w, h, rgba) {
        const raw = new Uint8Array((w * 4 + 1) * h);
        for (let y = 0; y < h; y++) raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
        const z = await stream(raw, CompressionStream, 'deflate');
        const chunk = (type, d) => {
            const t = new Uint8Array(4 + d.length);
            for (let i = 0; i < 4; i++) t[i] = type.charCodeAt(i);
            t.set(d, 4);
            const o = new Uint8Array(12 + d.length), v = new DataView(o.buffer);
            v.setUint32(0, d.length); o.set(t, 4); v.setUint32(8 + d.length, crc32(t));
            return o;
        };
        const ihdr = new Uint8Array(13), v = new DataView(ihdr.buffer);
        v.setUint32(0, w); v.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 6;
        const parts = [Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), chunk('IHDR', ihdr), chunk('IDAT', z), chunk('IEND', new Uint8Array(0))];
        const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
        let o = 0;
        for (const p of parts) { out.set(p, o); o += p.length; }
        return out;
    }

    // ---------------------------------------------------------------- reading a zip someone made of their edits
    async function readZip(bytes) {
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let e = bytes.length - 22;
        while (e >= 0 && dv.getUint32(e, true) !== 0x06054B50) e--;
        if (e < 0) throw new Error('not a zip file');
        const out = [], count = dv.getUint16(e + 10, true);
        let o = dv.getUint32(e + 16, true);
        for (let i = 0; i < count; i++) {
            if (dv.getUint32(o, true) !== 0x02014B50) throw new Error('its table of contents is damaged');
            const method = dv.getUint16(o + 10, true), packed = dv.getUint32(o + 20, true), nameLen = dv.getUint16(o + 28, true), extra = dv.getUint16(o + 30, true), note = dv.getUint16(o + 32, true), local = dv.getUint32(o + 42, true);
            const name = new TextDecoder().decode(bytes.subarray(o + 46, o + 46 + nameLen));
            o += 46 + nameLen + extra + note;
            if (name.endsWith('/')) continue;
            const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true), data = bytes.subarray(start, start + packed);
            if (method === 0) out.push({ path: name, bytes: data });
            else if (method === 8) out.push({ path: name, bytes: await stream(data, DecompressionStream, 'deflate-raw') });
            else throw new Error(name + ' is packed in a way this tool cannot read');
        }
        return out;
    }

    // ---------------------------------------------------------------- the export
    function csvCell(v) {
        const s = String(v);
        return /[",\r\n]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
    }

    /** manifest.csv, the same bytes export_textures.py writes. */
    function manifest(rom) {
        const head = ['id', 'file', 'folder', 'name', 'name_source', 'rom', 'ram', 'format', 'width', 'height', 'row_bytes', 'bytes', 'palette_rom', 'palette_source', 'md5', 'used_by', 'also_loaded_as', 'render_mode', 'source', 'note'];
        const lines = [head.join(',')];
        for (const t of records) {
            const raw = rawOf(rom, t), id = '0x' + hex6(t.rom);
            lines.push([id, t.file, t.folder, t.name, t.name_source, id, t.ram ? '0x' + t.ram.toString(16).toUpperCase().padStart(8, '0') : '', t.fmt + t.siz, t.w, t.h, rowBytes(t), raw.length,
                t.pal !== null ? '0x' + hex6(t.pal) : '', t.pal_src || (t.fmt === 'CI' ? 'none found' : ''), md5(raw), t.users, t.also, t.rm, t.source, t.note].map(csvCell).join(','));
        }
        return lines.join('\r\n') + '\r\n';
    }

    /** One swatch per palette: 12 x 12 blocks, 16 across, as write_palettes draws them. */
    function paletteSwatch(rom, [name, o, n]) {
        const P = pal5551(rom, o, n), w = 16 * 12, h = (n >> 4) * 12, px = new Uint8Array(w * h * 4);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const c = P[(y / 12 | 0) * 16 + (x / 12 | 0)];
            px.set(c, (y * w + x) * 4);
        }
        return { name: `${name}_${hex6(o)}.png`, w, h, px };
    }

    /** Every file of an export. The contact sheets and coverage.txt are left out: the Textures tab does their job. */
    async function exportAll(rom, progress) {
        const files = [], enc = new TextEncoder();
        files.push(['rom.json', enc.encode('{\n "rom": "the original Japanese ROM",\n "sha1": "4161b5c100ec82b0241b20ca8f81366e23564ccb",\n "ids_are_offsets_in": "this ROM"\n}')]);
        files.push(['manifest.csv', enc.encode(manifest(rom))]);
        for (let i = 0; i < records.length; i++) {
            const t = records[i];
            files.push([t.folder + '/' + t.file, await writePng(t.w, t.h, decode(rom, t))]);
            if (progress && i % 40 === 0) await progress(i, records.length);
        }
        for (const p of T.palettes) { const s = paletteSwatch(rom, p); files.push(['palettes/' + s.name, await writePng(s.w, s.h, s.px)]); }
        return files;
    }

    // ---------------------------------------------------------------- the import
    class Refused extends Error {}

    class Importer {
        constructor(rom, { strict = false, allCopies = false } = {}) {
            this.src = rom; this.strict = strict; this.allCopies = allCopies;
            this.byKey = new Map(); this.byArt = new Map();
            for (const t of records) {
                const k = `${t.rom}|${t.fmt.toLowerCase()}|${t.siz}`;
                if (!this.byKey.has(k)) this.byKey.set(k, []);
                this.byKey.get(k).push(t);
                const art = this.artKey(t);
                if (!this.byArt.has(art)) this.byArt.set(art, new Set());
                this.byArt.get(art).add(t.rom);
            }
        }
        artKey(t) { return `${md5(rawOf(this.src, t))}|${t.fmt}|${t.siz}|${t.w}|${t.h}`; }

        record(name) {
            if (name.startsWith('en_')) throw new Refused('it comes from another export (en_): this builds on the original Japanese ROM only');
            const m = TAIL.exec(name);
            if (!m) throw new Refused('its name does not end in _<ROM offset>_<W>x<H>_<format>.png, so it cannot be matched to the ROM');
            const o = parseInt(m[1], 16), fmt = m[4], siz = +m[5], pal = m[6];
            let rows = this.byKey.get(`${o}|${fmt}|${siz}`);
            if (!rows) throw new Refused(`no exported texture has this offset and format (0x${hex6(o)}, ${fmt}${siz})`);
            if (pal) rows = rows.filter(t => t.pal === parseInt(pal, 16));
            if (rows.length !== 1) throw new Refused('it does not pick out one exported texture (palette variants: keep the _pal part of the name)');
            return rows[0];
        }

        /** { offset: new byte } for the texels that changed, plus counts for the report. */
        encode(t, img) {
            const { w, h, fmt, siz } = t, info = {}, out = new Map(), rom = this.src;
            const count = k => { info[k] = (info[k] || 0) + 1; };
            if (img.w !== w || img.h !== h) throw new Refused(`it is ${img.w}x${img.h}; it must stay ${w}x${h}`);
            const old = decode(rom, t), nw = img.px;
            let same = true;
            for (let i = 0; i < old.length; i++) if (old[i] !== nw[i]) { same = false; break; }
            if (same) return { changes: out, info };
            const row = rowBytes(t), base = t.rom;
            let slots = null;
            if (fmt === 'CI') {
                if (t.pal === null) throw new Refused('its palette is not known, so colours cannot be matched');
                slots = palFor(rom, t).map(c => [TO5(c[0]), TO5(c[1]), TO5(c[2]), c[3] ? 1 : 0]);
            }
            const nibble = (y, x, v) => {
                const at = base + y * row + (x >> 1), cur = out.has(at) ? out.get(at) : rom[at];
                out.set(at, x % 2 === 0 ? (cur & 0x0F) | v << 4 : (cur & 0xF0) | v);
            };
            const n = w * h;
            for (let i = 0; i < n; i++) {
                const a = [old[i * 4], old[i * 4 + 1], old[i * 4 + 2], old[i * 4 + 3]], b = [nw[i * 4], nw[i * 4 + 1], nw[i * 4 + 2], nw[i * 4 + 3]];
                if ((a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3]) || (a[3] === 0 && b[3] === 0)) continue;     // an editor may clear the colour under a transparent pixel
                const x = i % w, y = Math.floor(i / w);
                if (fmt === 'RGBA' && siz === 16) {
                    const at = base + y * row + 2 * x, cur = rom[at] << 8 | rom[at + 1];
                    let alpha;
                    if (t.opaque) {
                        if (b[3] < 128) { count('erased in an opaque file: kept'); continue; }
                        alpha = cur & 1;
                    } else alpha = b[3] >= 128 ? 1 : 0;
                    const k = key5(...b), v = k[0] << 11 | k[1] << 6 | k[2] << 1 | alpha;
                    if (v !== cur) { out.set(at, v >> 8); out.set(at + 1, v & 255); count('texels'); }
                } else if (fmt === 'CI') {
                    const k = key5(...b), ka = key5(...a);
                    if ((k[0] === ka[0] && k[1] === ka[1] && k[2] === ka[2] && k[3] === ka[3]) || (k[3] === 0 && ka[3] === 0)) continue;
                    let idx = slots.findIndex(s => s[0] === k[0] && s[1] === k[1] && s[2] === k[2] && s[3] === k[3]);
                    if (idx < 0) {
                        if (this.strict) throw new Refused(`pixel (${x}, ${y}) uses a colour not in its palette (stop on new colours is ticked)`);
                        let pool = [];
                        slots.forEach((s, m) => { if (s[3] === k[3]) pool.push(m); });
                        if (!pool.length) { pool = slots.map((_, m) => m); count('no slot with the wanted transparency'); }
                        let best = Infinity;
                        for (const m of pool) {
                            const d = (slots[m][0] - k[0]) ** 2 + (slots[m][1] - k[1]) ** 2 + (slots[m][2] - k[2]) ** 2;
                            if (d < best) { best = d; idx = m; }
                        }
                        count('snapped to the nearest palette colour');
                    }
                    if (siz === 8) out.set(base + y * row + x, idx); else nibble(y, x, idx);
                    count('texels');
                } else if (fmt === 'RGBA' && siz === 32) {
                    for (let c = 0; c < 4; c++) out.set(base + y * row + 4 * x + c, b[c]);
                    count('texels');
                } else {
                    if (b[0] !== b[1] || b[1] !== b[2]) count('coloured pixels made grey');
                    const g = Math.floor((b[0] * 299 + b[1] * 587 + b[2] * 114) / 1000);
                    const at = base + y * row;
                    if (fmt === 'I' && siz === 4) nibble(y, x, Math.floor((g + 8) / 17));
                    else if (fmt === 'I' && siz === 8) out.set(at + x, g);
                    else if (fmt === 'IA' && siz === 4) nibble(y, x, Math.floor((g * 7 + 127) / 255) << 1 | (b[3] >= 128 ? 1 : 0));
                    else if (fmt === 'IA' && siz === 8) out.set(at + x, Math.floor((g + 8) / 17) << 4 | Math.floor((b[3] + 8) / 17));
                    else { out.set(at + 2 * x, g); out.set(at + 2 * x + 1, b[3]); }
                    count('texels');
                }
            }
            for (const [k, v] of out) if (rom[k] === v) out.delete(k);
            return { changes: out, info };
        }

        /** files: [{ path, bytes }]. Returns { rom, lines, done } or { refused: [text] }: anything it cannot use stops the whole build. */
        async run(files, tints = {}) {
            const usable = files.map(f => ({ ...f, path: f.path.replaceAll('\\', '/') })).filter(f => {
                const parts = f.path.split('/');
                return !parts.slice(0, -1).includes('palettes') && parts[parts.length - 1].toLowerCase().endsWith('.png');
            });
            // folders first by their whole path, then files by name, as sorted(os.walk) does
            const dir = p => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); }, base = p => p.slice(p.lastIndexOf('/') + 1);
            const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
            usable.sort((a, b) => cmp(dir(a.path), dir(b.path)) || cmp(base(a.path), base(b.path)));
            const refused = [], done = [], writes = new Map();
            let read = 0, ignored = 0;
            for (const file of usable) {
                const f = base(file.path);
                if (f === '_sheet.png') { ignored++; continue; }
                read++;
                let t, changes, info;
                try {
                    t = this.record(f);
                    let img;
                    try { img = await readPng(file.bytes); } catch (e) { refused.push(`${file.path}: unreadable (${e.message})`); continue; }
                    ({ changes, info } = this.encode(t, img));
                } catch (e) {
                    if (!(e instanceof Refused)) throw e;
                    refused.push(`${file.path}: ${e.message}`);
                    continue;
                }
                if (!changes.size && !Object.keys(info).length) continue;
                const others = [...this.byArt.get(this.artKey(t))].filter(o => o !== t.rom).sort((a, b) => a - b);
                const targets = new Map(changes);
                if (this.allCopies) for (const o of others) for (const [k, v] of changes) targets.set(k - t.rom + o, v);
                let clash = null;
                for (const [k, v] of targets) if (writes.has(k) && writes.get(k)[1] !== v) { clash = k; break; }
                if (clash !== null) { refused.push(`${file.path}: writes a different value to ROM 0x${hex6(clash)} than ${writes.get(clash)[0]}`); continue; }
                for (const [k, v] of targets) writes.set(k, [f, v]);
                done.push({ f, t, changes, info, others });
            }
            const colours = [];
            for (const [at, rgb] of Object.entries(tints)) {
                const o = parseInt(at, 16);
                if (this.src[o] !== 0xFA) { refused.push(`tints.json: ROM 0x${hex6(o)} is not a colour command`); continue; }
                if (rgb.length !== 3 || rgb.some(v => !Number.isInteger(v) || v < 0 || v > 255)) { refused.push(`tints.json: ROM 0x${hex6(o)} wants a colour of three numbers from 0 to 255`); continue; }
                colours.push({ o, rgb, was: [this.src[o + 4], this.src[o + 5], this.src[o + 6]] });
                rgb.forEach((v, c) => writes.set(o + 4 + c, ['tints.json', v]));
            }
            if (!read && !colours.length) return { refused: [], none: true };
            if (refused.length) return { refused };
            const rom = new Uint8Array(this.src);
            for (const [k, [, v]] of writes) rom[k] = v;
            let crcChanged = false;
            if (writes.size) {
                const before = rom.slice(0x10, 0x18);
                fixCrc(rom);
                crcChanged = rom.slice(0x10, 0x18).some((v, i) => v !== before[i]);
            }
            const lines = this.report(done, writes, crcChanged);
            if (colours.length) {
                if (!done.length) lines.splice(2);
                lines.push(...colours.sort((a, b) => a.o - b.o).map(c => `colour at ROM 0x${hex6(c.o)}: ${c.was.join(', ')} -> ${c.rgb.join(', ')}`));
            }
            return { rom, lines, done, colours };
        }

        report(done, writes, crcChanged) {
            const out = [`${done.length} file(s) changed, ${writes.size} ROM byte(s) written; header checksum ${crcChanged ? 'recomputed' : 'unchanged'}.`, ''];
            for (const { f, t, changes, info, others } of done) {
                out.push(`${f}  (ROM 0x${hex6(t.rom)}, ${info.texels || 0} texels, ${changes.size} bytes)`);
                for (const k of Object.keys(info).sort()) if (k !== 'texels') out.push(`  ${k}: ${info[k]}`);
                if (t.pal_src === 'runtime') out.push('  its palette is faded at run time, so these colours will shift through the day');
                else if (t.pal_src === 'inherited') out.push('  its palette was inferred, not read from its own list: check it in play');
                if (others.length) out.push(`  same art also at ${others.map(o => '0x' + hex6(o)).join(' ')}: ${this.allCopies ? 'written too (also change identical copies is ticked)' : 'left alone (tick also change identical copies to change them)'}`);
            }
            if (!done.length) out.push('No edited pixels found: the new ROM is identical to the original.');
            return out;
        }
    }

    const byRom = new Map();
    for (const t of records) { if (!byRom.has(t.rom)) byRom.set(t.rom, []); byRom.get(t.rom).push(t); }
    /** The exported texture at this offset: with this palette if it has several, else the first. */
    function findRow(o, pal) {
        const rows = byRom.get(o);
        if (!rows) return null;
        return rows.find(t => t.pal === pal) || rows[0];
    }

    root.TextureTool = { findRow, records, palettes: T.palettes, decode, md5, fixCrc, readPng, writePng, readZip, manifest, paletteSwatch, exportAll, Importer, Refused, hex6, rowBytes };
})(globalThis);
