// Export: models to .glb with real bones and every animation, rooms to .glb, and a pose or room to a zip of OBJ, MTL and PNGs.
// No DOM and no outside libraries, so the same file runs in the page and in the test (Deno).
// Everything it writes comes from the ROM you opened; the files stay on your computer.
//
// A model's part table differs per animation: part counts, pivots and even parents change. A glTF has one skeleton, so:
// - joints are keyed on what a part draws (its display list, and which occurrence of it), not on its index;
// - the tree is the one most animations agree with, and each joint's rest pose stands at its pivot;
// - a part whose parent matches the tree takes the game's own local values, which a TRS holds exactly. Non-uniform scale through the
//   hierarchy then shears just as the game's matrices do (a flat skeleton could not: up to 716 units off);
// - a part whose parent differs in some animation (Brian's staff changing hands) gets a TRS worked out from the game's matrices. Where
//   that matrix holds shear, which one TRS cannot, a helper bone above it takes rotation and scale and the bone the second rotation: exact;
// - a part with several lists (the head, for the blink) has one leaf joint per list, switched by scale 0 or 1 on a STEP channel.
(function (root) {
    'use strict';
    const C = root.ModelCore;

    /** Game units to file units. glTF reads metres: at 0.1 Brian is about 1.4 m, and a room fits a 3D tool's default view (the largest, 1,090 m, just passes Blender's 1,000 m clip). */
    const EXPORT_SCALE = 0.1;

    /** glTF and Blender take base colours and vertex colours as linear. The game's values are display values; the PNGs are sRGB and stay as they are. */
    const toLinear = v => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));

    // ---------------------------------------------------------------- bytes: CRC, PNG (stored, not deflated), zip (stored)

    const CRC_TABLE = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
    function crc32(bytes, crc = 0xFFFFFFFF) { for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 255] ^ (crc >>> 8); return (crc ^ 0xFFFFFFFF) >>> 0; }
    const be32 = v => [v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    const ascii = s => Uint8Array.from(s, c => c.charCodeAt(0));

    function concat(parts) {
        let n = 0;
        for (const p of parts) n += p.length;
        const out = new Uint8Array(n);
        n = 0;
        for (const p of parts) { out.set(p, n); n += p.length; }
        return out;
    }

    /** An RGBA8 PNG. Stored rather than compressed: textures are tiny, and this stays synchronous and needs no library. */
    function encodePng(w, h, rgba) {
        const raw = new Uint8Array((w * 4 + 1) * h);
        for (let y = 0; y < h; y++) raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
        const blocks = [Uint8Array.of(0x78, 0x01)];
        for (let o = 0; o < raw.length || o === 0; o += 65535) {
            const n = Math.min(65535, raw.length - o), last = o + n >= raw.length ? 1 : 0;
            blocks.push(Uint8Array.of(last, n & 255, n >> 8, ~n & 255, (~n >> 8) & 255), raw.subarray(o, o + n));
        }
        let a = 1, b = 0;
        for (let i = 0; i < raw.length; i++) { a = (a + raw[i]) % 65521; b = (b + a) % 65521; }
        blocks.push(Uint8Array.from(be32(((b << 16) | a) >>> 0)));
        const chunk = (type, data) => {
            const t = concat([ascii(type), data]);
            return concat([Uint8Array.from(be32(data.length)), t, Uint8Array.from(be32(crc32(t)))]);
        };
        return concat([Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), chunk('IHDR', Uint8Array.from([...be32(w), ...be32(h), 8, 6, 0, 0, 0])), chunk('IDAT', concat(blocks)), chunk('IEND', new Uint8Array(0))]);
    }

    /** A zip with stored entries. */
    function makeZip(files) {
        const le16 = v => [v & 255, v >>> 8], le32 = v => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, v >>> 24];
        const locals = [], central = [];
        let offset = 0;
        for (const [name, data] of files) {
            const n = ascii(name), crc = crc32(data);
            const common = [...le16(20), ...le16(0x0800), ...le16(0), ...le16(0), ...le16(0x21), ...le32(crc), ...le32(data.length), ...le32(data.length), ...le16(n.length), ...le16(0)];
            const local = concat([Uint8Array.from([0x50, 0x4B, 3, 4, ...common]), n, data]);
            central.push(concat([Uint8Array.from([0x50, 0x4B, 1, 2, ...le16(20), ...common, ...le16(0), ...le16(0), ...le16(0), ...le32(0), ...le32(offset)]), n]));
            locals.push(local);
            offset += local.length;
        }
        const cd = concat(central);
        return concat([...locals, cd, Uint8Array.from([0x50, 0x4B, 5, 6, ...le16(0), ...le16(0), ...le16(files.length), ...le16(files.length), ...le32(cd.length), ...le32(offset), ...le16(0)])]);
    }

    // ---------------------------------------------------------------- textures and materials

    /** Nearest whole texel coordinate as the RDP reads it (renderer.js does the same in its shader). */
    function tileCoord(c, size, mask, mode) {
        if ((mode & 2) || !mask) c = Math.min(size - 1, Math.max(0, c));
        if (mask) {
            if ((mode & 1) && (c & mask)) c = ~c;
            c &= mask - 1;
        }
        return c;
    }

    /**
     * A tile as a picture a standard sampler can read: exactly the mask's size if it wraps or mirrors, the tile's size if it clamps.
     * The half-stored textures the game mirrors stay half-stored, with a mirrored sampler (OBJ has none, so bakeMirror doubles them).
     */
    function tileImage(tex, stats) {
        const d = tex.data, mw = tex.masks ? 1 << tex.masks : 0, mh = tex.maskt ? 1 << tex.maskt : 0;
        const clampS = (tex.cms & 2) !== 0 || !mw, clampT = (tex.cmt & 2) !== 0 || !mh;
        const w = clampS ? d.tileW : mw, h = clampT ? d.tileH : mh;
        if (clampS && mw && d.tileW > mw && stats) stats.clampMask = (stats.clampMask || 0) + 1;
        if (clampT && mh && d.tileH > mh && stats) stats.clampMask = (stats.clampMask || 0) + 1;
        const px = new Uint8Array(w * h * 4);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const sx = clampS ? tileCoord(x, d.tileW, mw, tex.cms) : x, sy = clampT ? tileCoord(y, d.tileH, mh, tex.cmt) : y;
                const i = (sy * d.w + sx) * 4, o = (y * w + x) * 4;
                px[o] = d.px[i]; px[o + 1] = d.px[i + 1]; px[o + 2] = d.px[i + 2]; px[o + 3] = d.px[i + 3];
            }
        }
        const wrap = (clamp, mode) => clamp ? 33071 : (mode & 1) ? 33648 : 10497;        // CLAMP_TO_EDGE, MIRRORED_REPEAT, REPEAT
        return { w, h, px, wrapS: wrap(clampS, tex.cms), wrapT: wrap(clampT, tex.cmt) };
    }

    /** A vertex's texture coordinates. A texel's middle is +0.5 in glTF; at the RDP a whole coordinate lands on that texel. */
    function vertexUV(tex, img, s, t) {
        return [(s * tex.scaleS - tex.uls + 0.5) / img.w, (t * tex.scaleT - tex.ult + 0.5) / img.h];
    }

    /** The combiner's constant part, with texture and shade taken as white. Exact for the game's texture x shade x constant family. */
    function combinerFactor(mat, stats) {
        const white = [1, 1, 1, 1], prim = mat.prim.map(v => v / 255), env = mat.env.map(v => v / 255);
        const src = (n, comb, rgbaIndex) => {
            const V = { T0: white, T1: white, SHADE: white, PRIM: prim, ENV: env, COMBINED: comb, ONE: white, ZERO: [0, 0, 0, 0] };
            if (n.endsWith('_A')) { const b = V[n.slice(0, -2)] || white; return b[3]; }
            if (n === 'PRIM_LOD') return 1;
            const v = V[n];
            if (!v) { if (stats) stats.otherCombine = (stats.otherCombine || 0) + 1; return 0; }
            return v[rgbaIndex];
        };
        const run = (q, comb) => {
            const out = [0, 1, 2].map(i => (src(q.a, comb, i) - src(q.b, comb, i)) * src(q.c, comb, i) + src(q.d, comb, i));
            out.push((src(q.Aa, comb, 3) - src(q.Ab, comb, 3)) * src(q.Ac, comb, 3) + src(q.Ad, comb, 3));
            return out.map(v => Math.min(1, Math.max(0, v)));
        };
        let c = run(mat.combine.c0, [0, 0, 0, 0]);
        if (mat.two) c = run(mat.combine.c1, c);
        return c;
    }

    /** glTF output with one binary buffer. */
    class Glb {
        constructor(generator) {
            this.json = {
                asset: { version: '2.0', generator }, scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [], materials: [], textures: [], images: [], samplers: [], accessors: [], bufferViews: [], buffers: [{ byteLength: 0 }],
            };
            this.parts = [];
            this.length = 0;
            this.materialIndex = new Map();
            this.imageIndex = new Map();
            this.samplerIndex = new Map();
            this.stats = {};
        }
        view(bytes, target) {
            const pad = (4 - (this.length % 4)) % 4;
            if (pad) { this.parts.push(new Uint8Array(pad)); this.length += pad; }
            const v = { buffer: 0, byteOffset: this.length, byteLength: bytes.length };
            if (target) v.target = target;
            this.json.bufferViews.push(v);
            this.parts.push(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
            this.length += bytes.length;
            return this.json.bufferViews.length - 1;
        }
        accessor(typed, type, componentType, target, extra = {}) {
            const size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[type];
            const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
            const a = Object.assign({ bufferView: this.view(bytes, target), componentType, count: typed.length / size, type }, extra);
            this.json.accessors.push(a);
            return this.json.accessors.length - 1;
        }
        /** POSITION needs min and max; so do animation inputs. */
        accessorBounds(typed, type, componentType, target) {
            const size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[type], min = new Array(size).fill(Infinity), max = new Array(size).fill(-Infinity);
            for (let i = 0; i < typed.length; i++) { const c = i % size; if (typed[i] < min[c]) min[c] = typed[i]; if (typed[i] > max[c]) max[c] = typed[i]; }
            return this.accessor(typed, type, componentType, target, { min, max });
        }
        sampler(mat, img) {
            const nearest = mat.filter === 0;
            const key = [img.wrapS, img.wrapT, nearest].join();
            if (!this.samplerIndex.has(key)) {
                this.json.samplers.push({ magFilter: nearest ? 9728 : 9729, minFilter: nearest ? 9728 : 9729, wrapS: img.wrapS, wrapT: img.wrapT });
                this.samplerIndex.set(key, this.json.samplers.length - 1);
            }
            return this.samplerIndex.get(key);
        }
        image(tex) {
            if (!this.imageIndex.has(tex.key)) {
                const img = tileImage(tex, this.stats);
                const bytes = encodePng(img.w, img.h, img.px);
                this.json.images.push({ bufferView: this.view(bytes), mimeType: 'image/png', name: 'tex_' + tex.data.hash.toString(16).padStart(8, '0') + '_' + img.w + 'x' + img.h });
                img.index = this.json.images.length - 1;
                this.imageIndex.set(tex.key, img);
            }
            return this.imageIndex.get(tex.key);
        }
        /** unlit: colour comes from COLOR_0 with no scene lighting. Lit: a plain matte surface that takes the importing scene's lights. */
        material(mat, unlit) {
            const key = mat.key + (unlit ? '|unlit' : '|lit');
            if (this.materialIndex.has(key)) return this.materialIndex.get(key);
            const raw = combinerFactor(mat, this.stats), f = [toLinear(raw[0]), toLinear(raw[1]), toLinear(raw[2]), raw[3]];
            const m = { name: 'mat_' + this.json.materials.length, pbrMetallicRoughness: { baseColorFactor: f, metallicFactor: 0, roughnessFactor: 1 } };
            if (mat.tex0) {
                const img = this.image(mat.tex0);
                let ti = this.json.textures.findIndex(t => t.source === img.index && t.sampler === this.sampler(mat, img));
                if (ti < 0) { this.json.textures.push({ source: img.index, sampler: this.sampler(mat, img) }); ti = this.json.textures.length - 1; }
                m.pbrMetallicRoughness.baseColorTexture = { index: ti };
            }
            if (mat.tex1) this.stats.secondTexture = (this.stats.secondTexture || 0) + 1;
            if (mat.cutout) { m.alphaMode = 'MASK'; m.alphaCutoff = 0.5; } else if (mat.blend) m.alphaMode = 'BLEND';
            if (!mat.cullBack) m.doubleSided = true;
            if (unlit) {
                m.extensions = { KHR_materials_unlit: {} };
                if (!this.json.extensionsUsed) this.json.extensionsUsed = ['KHR_materials_unlit'];
            }
            this.json.materials.push(m);
            this.materialIndex.set(key, this.json.materials.length - 1);
            return this.json.materials.length - 1;
        }
        finish() {
            const J = this.json;
            for (const k of ['textures', 'images', 'samplers', 'materials', 'meshes']) if (!J[k].length) delete J[k];
            const pad4 = n => (4 - (n % 4)) % 4;
            const bin = new Uint8Array(this.length + pad4(this.length));
            let o = 0;
            for (const p of this.parts) { bin.set(p, o); o += p.length; }
            J.buffers[0].byteLength = bin.length;
            const text = JSON.stringify(J), jsonBytes = new TextEncoder().encode(text);
            const jsonLen = jsonBytes.length + pad4(jsonBytes.length), total = 12 + 8 + jsonLen + 8 + bin.length;
            const out = new Uint8Array(total), dv = new DataView(out.buffer);
            dv.setUint32(0, 0x46546C67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
            dv.setUint32(12, jsonLen, true); dv.setUint32(16, 0x4E4F534A, true);
            out.fill(0x20, 20, 20 + jsonLen);
            out.set(jsonBytes, 20);
            dv.setUint32(20 + jsonLen, bin.length, true); dv.setUint32(24 + jsonLen, 0x004E4942, true);
            out.set(bin, 28 + jsonLen);
            return out;
        }
    }

    // ---------------------------------------------------------------- matrices (row vectors, as the game: v * M; mf[r][c] = m[r * 4 + c])

    function full(a, b) {
        const o = new Float64Array(16);
        for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) o[r * 4 + c] = a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c] + a[r * 4 + 3] * b[12 + c];
        return o;
    }
    const translate = p => new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, p[0], p[1], p[2], 1]);
    const IDENTITY = translate([0, 0, 0]);

    function inverse(m) {
        const a = m[0], b = m[1], c = m[2], d = m[4], e = m[5], f = m[6], g = m[8], h = m[9], i = m[10];
        const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
        if (Math.abs(det) < 1e-12) return null;
        const o = new Float64Array(16), s = 1 / det;
        o[0] = (e * i - f * h) * s; o[1] = (c * h - b * i) * s; o[2] = (b * f - c * e) * s;
        o[4] = (f * g - d * i) * s; o[5] = (a * i - c * g) * s; o[6] = (c * d - a * f) * s;
        o[8] = (d * h - e * g) * s; o[9] = (b * g - a * h) * s; o[10] = (a * e - b * d) * s;
        o[12] = -(m[12] * o[0] + m[13] * o[4] + m[14] * o[8]); o[13] = -(m[12] * o[1] + m[13] * o[5] + m[14] * o[9]); o[14] = -(m[12] * o[2] + m[13] * o[6] + m[14] * o[10]); o[15] = 1;
        return o;
    }

    /** A rotation from unit axes. The game's rows are glTF's columns. */
    function quatFromRows(r) {
        const m00 = r[0], m10 = r[1], m20 = r[2], m01 = r[4], m11 = r[5], m21 = r[6], m02 = r[8], m12 = r[9], m22 = r[10], t = m00 + m11 + m22;
        let x, y, z, w;
        if (t > 0) { const s = Math.sqrt(t + 1) * 2; w = s / 4; x = (m21 - m12) / s; y = (m02 - m20) / s; z = (m10 - m01) / s; }
        else if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; w = (m21 - m12) / s; x = s / 4; y = (m01 + m10) / s; z = (m02 + m20) / s; }
        else if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; w = (m02 - m20) / s; x = (m01 + m10) / s; y = s / 4; z = (m12 + m21) / s; }
        else { const s = Math.sqrt(1 + m22 - m00 - m11) * 2; w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = s / 4; }
        const l = Math.hypot(x, y, z, w) || 1;
        return [x / l, y / l, z / l, w / l];
    }

    /** The TRS closest to an arbitrary matrix (it cannot hold shear). */
    function decompose(m) {
        let sx = Math.hypot(m[0], m[1], m[2]), sy = Math.hypot(m[4], m[5], m[6]);
        const sz0 = Math.hypot(m[8], m[9], m[10]);
        const ux = sx ? [m[0] / sx, m[1] / sx, m[2] / sx] : [1, 0, 0];
        let uy = sy ? [m[4] / sy, m[5] / sy, m[6] / sy] : [0, 1, 0];
        const d = ux[0] * uy[0] + ux[1] * uy[1] + ux[2] * uy[2];
        uy = [uy[0] - d * ux[0], uy[1] - d * ux[1], uy[2] - d * ux[2]];
        const ly = Math.hypot(uy[0], uy[1], uy[2]) || 1;
        uy = uy.map(v => v / ly);
        const uz = [ux[1] * uy[2] - ux[2] * uy[1], ux[2] * uy[0] - ux[0] * uy[2], ux[0] * uy[1] - ux[1] * uy[0]];
        const sign = m[8] * uz[0] + m[9] * uz[1] + m[10] * uz[2] < 0 ? -1 : 1;
        return { t: [m[12], m[13], m[14]], r: quatFromRows([ux[0], ux[1], ux[2], 0, uy[0], uy[1], uy[2], 0, uz[0], uz[1], uz[2], 0]), s: [sx, sy, sz0 * sign] };
    }

    /** Any 3 x 3 as R1 * S * R2 (the game's rows are the columns here): a helper node holds R1 and S, the joint R2. Jacobi, on the matrix's normal form. */
    function splitShear(L) {
        const A = [[L[0], L[4], L[8]], [L[1], L[5], L[9]], [L[2], L[6], L[10]]];        // columns as glTF has them
        const N = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) N[i][j] += A[k][i] * A[k][j];
        const V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
        for (let sweep = 0; sweep < 32; sweep++) {
            for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
                if (Math.abs(N[p][q]) < 1e-14) continue;
                const th = (N[q][q] - N[p][p]) / (2 * N[p][q]), t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
                for (let k = 0; k < 3; k++) { const a = N[k][p], b = N[k][q]; N[k][p] = c * a - s * b; N[k][q] = s * a + c * b; }
                for (let k = 0; k < 3; k++) { const a = N[p][k], b = N[q][k]; N[p][k] = c * a - s * b; N[q][k] = s * a + c * b; }
                for (let k = 0; k < 3; k++) { const a = V[k][p], b = V[k][q]; V[k][p] = c * a - s * b; V[k][q] = s * a + c * b; }
            }
        }
        const det3 = m => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
        if (det3(V) < 0) for (let k = 0; k < 3; k++) V[k][2] = -V[k][2];
        const S = [0, 1, 2].map(j => Math.sqrt(Math.max(0, N[j][j])));
        const U = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
        for (let j = 0; j < 3; j++) {
            for (let i = 0; i < 3; i++) { let v = 0; for (let k = 0; k < 3; k++) v += A[i][k] * V[k][j]; U[i][j] = S[j] > 1e-12 ? v / S[j] : 0; }
        }
        const col = j => [U[0][j], U[1][j], U[2][j]], len = c => Math.hypot(c[0], c[1], c[2]);
        const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
        for (let j = 0; j < 3; j++) {           // a zero scale leaves that axis free: complete it
            if (len(col(j)) < 0.5) {
                const a = col((j + 1) % 3), b = col((j + 2) % 3);
                let c = len(a) > 0.5 && len(b) > 0.5 ? cross(a, b) : len(a) > 0.5 ? cross(a, Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]) : len(b) > 0.5 ? cross(Math.abs(b[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0], b) : [j === 0 ? 1 : 0, j === 1 ? 1 : 0, j === 2 ? 1 : 0];
                const l = len(c) || 1;
                c = c.map(v => v / l);
                for (let i = 0; i < 3; i++) U[i][j] = c[i];
            }
        }
        if (det3(U) < 0) { for (let i = 0; i < 3; i++) U[i][2] = -U[i][2]; S[2] = -S[2]; }
        // quatFromRows reads its input's rows as a matrix's columns. R2 is V transposed.
        const asColumns = m => [m[0][0], m[1][0], m[2][0], 0, m[0][1], m[1][1], m[2][1], 0, m[0][2], m[1][2], m[2][2], 0];
        const Vt = [[V[0][0], V[1][0], V[2][0]], [V[0][1], V[1][1], V[2][1]], [V[0][2], V[1][2], V[2][2]]];
        return { helper: { t: [L[12], L[13], L[14]], r: quatFromRows(asColumns(U)), s: S }, joint: { t: [0, 0, 0], r: quatFromRows(asColumns(Vt)), s: [1, 1, 1] } };
    }

    function trsMatrix(trs) {
        const [x, y, z, w] = trs.r, [sx, sy, sz] = trs.s;
        // The game's rows: glTF's columns.
        return new Float64Array([
            (1 - 2 * (y * y + z * z)) * sx, (2 * (x * y + z * w)) * sx, (2 * (x * z - y * w)) * sx, 0,
            (2 * (x * y - z * w)) * sy, (1 - 2 * (x * x + z * z)) * sy, (2 * (y * z + x * w)) * sy, 0,
            (2 * (x * z + y * w)) * sz, (2 * (y * z - x * w)) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
            trs.t[0], trs.t[1], trs.t[2], 1,
        ]);
    }

    // ---------------------------------------------------------------- a model: joints, geometry, animation

    /** Which lists a part can draw: its per-frame table, else its one list. */
    function partLists(mem, p) {
        if (p.dlistFrames) {
            const out = [];
            for (let i = 0; i < p.dlistFrameCount; i++) { const v = mem.s32(p.dlistFrames + i * 4); if (!out.includes(v)) out.push(v); }
            return out;
        }
        return p.dlist >= 0 ? [p.dlist] : [];
    }

    /** Lists a per-frame table shows together are one part's variants (Brian's head: 0, 23, 24), whichever way an animation reaches them. */
    function variantGroups(info) {
        const group = new Map();
        for (const I of info) {
            for (const p of I.parts) {
                if (!p.dlistFrames) continue;
                const lists = partLists(I.mem, p), id = Math.min(...lists);
                for (const d of lists) group.set(d, id);
            }
        }
        return group;
    }

    function partKeys(I, group) {
        const occ = {}, out = [];
        for (const p of I.parts) {
            let base;
            const lists = partLists(I.mem, p);
            if (lists.length && group.has(lists[0])) base = 'v' + group.get(lists[0]);
            else base = p.dlist >= 0 ? 'd' + p.dlist : 'n';
            occ[base] = (occ[base] || 0) + 1;
            out.push(base + '#' + occ[base]);
        }
        return out;
    }

    /** Read every animation's tables once. Each anim gives { prep(), addr, rate, name }. */
    function readAnimations(mem, anims) {
        return anims.map(A => {
            A.prep();
            const entry = C.readAnimEntry(mem, A.addr);
            return { A, mem, entry, parts: C.readParts(mem, entry) };
        });
    }

    /** The tree most animations agree with, plus any joint only other animations have. */
    function buildTree(info) {
        const parentIn = (I, i) => (I.parts[i].parent ? I.keys[I.parts[i].parent - 1] : null);
        let best = null, bestScore = -1;
        for (const cand of info) {
            const want = {};
            cand.parts.forEach((p, i) => { want[cand.keys[i]] = parentIn(cand, i); });
            let score = 0;
            for (const I of info) I.parts.forEach((p, i) => { if (want[I.keys[i]] === parentIn(I, i) && I.keys[i] in want) score += 2; });
            score += cand.parts.length;
            if (score > bestScore) { bestScore = score; best = cand; }
        }
        const joints = new Map();
        best.parts.forEach((p, i) => joints.set(best.keys[i], { key: best.keys[i], parent: parentIn(best, i), pivot: Array.from(p.pivot) }));
        for (const I of info) I.parts.forEach((p, i) => { if (!joints.has(I.keys[i])) joints.set(I.keys[i], { key: I.keys[i], parent: parentIn(I, i), pivot: Array.from(p.pivot) }); });
        // A parent from another animation's tree could close a loop: such a joint hangs from the root instead.
        for (const j of joints.values()) {
            const seen = new Set([j.key]);
            for (let p = j.parent; p; p = joints.get(p) ? joints.get(p).parent : null) {
                if (!joints.has(p) || seen.has(p)) { j.parent = null; break; }
                seen.add(p);
            }
        }
        return joints;
    }

    /** One part's local TRS at a frame, the game's own values, with the bone's origin moved to the joint's pivot and the parent's. */
    function localTRS(part, frame, flags, jointPivot, parentPivot) {
        const key = new Float64Array(9), f = part.frames !== 0 ? frame % part.frames : 0;
        C.sampleSpline(part, f, key);
        let x = key[0], y = key[1], z = key[2];
        if (part.parent === 0) {
            if (flags & 1) x = z = 0;
            if (flags & 2) y = 0;
        }
        const DEG = 0.017453292;
        const R = C.buildActorMatrix(key[4] * DEG, key[3] * DEG, key[5] * DEG, 1, 0, 0, 0);
        const S = [key[6], key[7], key[8]];
        // v' = (v + jointPivot - part.pivot) * S * R + key position - parentPivot
        const d = [jointPivot[0] - part.pivot[0], jointPivot[1] - part.pivot[1], jointPivot[2] - part.pivot[2]];
        const sd = [d[0] * S[0], d[1] * S[1], d[2] * S[2]];
        return {
            t: [
                sd[0] * R[0] + sd[1] * R[4] + sd[2] * R[8] + x - parentPivot[0],
                sd[0] * R[1] + sd[1] * R[5] + sd[2] * R[9] + y - parentPivot[1],
                sd[0] * R[2] + sd[1] * R[6] + sd[2] * R[10] + z - parentPivot[2],
            ],
            r: quatFromRows(R), s: S,
        };
    }

    /**
     * Everything an exported model is built from, with no file format in it (the test reads this too).
     * opts: { mem, anims: [{ prep, addr, rate, name }], state, flags, scale, name }
     */
    function buildModel(opts) {
        const { mem, anims, state, flags } = opts;
        const info = readAnimations(mem, anims);
        const groups = variantGroups(info);
        for (const I of info) I.keys = partKeys(I, groups);
        const joints = buildTree(info);
        const ORIGIN = [0, 0, 0];
        const pivotOf = k => (k ? joints.get(k).pivot : ORIGIN);
        // Geometry, in the game's draw order: 215 lists depend on the state the list before them left.
        const meshTris = new Map();
        const order = [...info].sort((a, b) => b.parts.length - a.parts.length);
        for (const I of order) {
            I.A.prep();
            const rsp = new C.Rsp(mem, {});
            rsp.capture = true;
            rsp.reset();
            rsp.setState(state);
            const pose = C.posePart(mem, { entry: I.entry, parts: I.parts }, IDENTITY, 0, 0, flags);
            for (const p of pose) {
                const part = I.parts[p.index], key = I.keys[p.index], lists = partLists(mem, part);
                rsp.mtx = IDENTITY;
                const before = rsp.snapshot();
                const after = [];
                lists.forEach((d, n) => {
                    const addr = mem.u32(I.entry.dlistsAddr + d * 4);
                    if (!addr) return;
                    if (n) rsp.setState(before);
                    const tag = key + '|' + d, have = meshTris.has(tag);
                    const start = rsp.captured.length;
                    rsp.captureTag = tag;
                    rsp.run(addr);
                    if (!have) meshTris.set(tag, rsp.captured.slice(start));
                    if (n === 0) after.push(rsp.snapshot());
                });
                if (after.length) rsp.setState(after[0]);
            }
        }
        // The joints a mesh binds to: its part's, or a leaf when a part switches between lists or is missing from an animation it has children in.
        const childrenOf = new Map();
        for (const j of joints.values()) if (j.parent) childrenOf.set(j.parent, (childrenOf.get(j.parent) || 0) + 1);
        const presentIn = I => new Set(I.keys);
        const listsByJoint = new Map();
        for (const tag of meshTris.keys()) { const [k, d] = tag.split('|'); if (!listsByJoint.has(k)) listsByJoint.set(k, []); listsByJoint.get(k).push(+d); }
        const needsLeaf = new Set();
        for (const [k, ds] of listsByJoint) {
            if (ds.length > 1) needsLeaf.add(k);
            if (childrenOf.get(k) && info.some(I => !presentIn(I).has(k))) needsLeaf.add(k);
        }
        // Clips: the frames the game shows, one per tick.
        const clips = info.map(I => {
            I.A.prep();
            const here = new Map();
            I.keys.forEach((k, i) => here.set(k, i));
            const model = { entry: I.entry, parts: I.parts };
            const ticks = [];
            for (let f = 0; f < I.entry.frames; f += I.A.rate) ticks.push(f);
            const closing = (ticks[ticks.length - 1] + I.A.rate) % I.entry.frames;
            const samples = [...ticks, closing];
            const tracks = new Map();
            for (const k of joints.keys()) tracks.set(k, []);
            const moved = new Set(I.keys.filter((k, i) => {
                const gp = I.parts[i].parent ? I.keys[I.parts[i].parent - 1] : null;
                return gp !== joints.get(k).parent;
            }));
            const leafs = new Map();
            samples.forEach((f, tickIndex) => {
                const total = tickIndex;
                const pose = moved.size ? C.posePart(mem, model, IDENTITY, f, total, flags) : null;
                const world = pose ? new Map(pose.map(p => [I.keys[p.index], p.mtx])) : null;
                const G = new Map();
                const visit = k => {
                    if (G.has(k)) return G.get(k);
                    const j = joints.get(k), pk = j.parent, PG = pk ? visit(pk) : IDENTITY;
                    let trs;
                    const i = here.get(k);
                    if (i === undefined) {
                        // Not in this animation. Hidden if nothing hangs from it, else it holds still.
                        trs = { t: [j.pivot[0] - pivotOf(pk)[0], j.pivot[1] - pivotOf(pk)[1], j.pivot[2] - pivotOf(pk)[2]], r: [0, 0, 0, 1], s: childrenOf.get(k) ? [1, 1, 1] : [0, 0, 0] };
                    } else if (!moved.has(k)) {
                        trs = localTRS(I.parts[i], f, flags, j.pivot, pivotOf(pk));
                    } else {
                        const target = full(translate(j.pivot), world.get(k)), inv = inverse(PG), L = inv ? full(target, inv) : target;
                        trs = decompose(L);
                        const back = trsMatrix(trs);
                        let sheared = false;
                        for (let e = 0; e < 12; e++) if (Math.abs(back[e] - L[e]) > 1e-4) sheared = true;
                        if (sheared) {
                            const parts = splitShear(L);
                            trs = parts.joint;
                            trs.helper = parts.helper;
                            j.helper = true;
                        }
                    }
                    tracks.get(k).push(trs);
                    const own = trsMatrix(trs), M = full(trs.helper ? full(own, trsMatrix(trs.helper)) : own, PG);
                    G.set(k, M);
                    return M;
                };
                for (const k of joints.keys()) visit(k);
                // Which list each switching part shows at this tick.
                for (const k of needsLeaf) {
                    const i = here.get(k);
                    let shown = null;
                    if (i !== undefined) {
                        const p = I.parts[i];
                        shown = p.dlistFrames ? mem.s32(p.dlistFrames + 4 * (total % p.dlistFrameCount)) : p.dlist;
                    }
                    for (const d of listsByJoint.get(k)) {
                        const lk = k + '|' + d;
                        if (!leafs.has(lk)) leafs.set(lk, []);
                        leafs.get(lk).push(shown === d ? 1 : 0);
                    }
                }
            });
            return { name: I.A.name, ticks, closing, samples, tracks, leafs, rate: I.A.rate, frames: I.entry.frames };
        });
        return { info, joints, meshTris, needsLeaf, listsByJoint, clips, scale: opts.scale, name: opts.name };
    }

    /** The binary glTF for a model: a skeleton, one skinned mesh, every animation. */
    function modelToGlb(B) {
        const g = new Glb('Eltale Model Viewer'), J = g.json;
        const rootScale = B.scale * EXPORT_SCALE;
        const rootNode = J.nodes.push({ name: B.name, scale: [rootScale, rootScale, rootScale], children: [] }) - 1;
        const nodeOf = new Map();
        for (const j of B.joints.values()) {
            const parentPivot = j.parent ? B.joints.get(j.parent).pivot : [0, 0, 0];
            nodeOf.set(j.key, J.nodes.push({ name: j.key.replace('#1', ''), translation: [j.pivot[0] - parentPivot[0], j.pivot[1] - parentPivot[1], j.pivot[2] - parentPivot[2]] }) - 1);
        }
        const helperOf = new Map();
        for (const j of B.joints.values()) {
            const pn = j.parent ? J.nodes[nodeOf.get(j.parent)] : J.nodes[rootNode];
            if (j.helper) {         // parent -> helper (identity at rest and in most frames) -> joint
                const h = J.nodes.push({ name: j.key.replace('#1', '') + ' helper', children: [nodeOf.get(j.key)] }) - 1;
                helperOf.set(j.key, h);
                (pn.children = pn.children || []).push(h);
            } else (pn.children = pn.children || []).push(nodeOf.get(j.key));
        }
        const leafNode = new Map();
        for (const k of B.needsLeaf) {
            for (const d of B.listsByJoint.get(k)) {
                const n = J.nodes.push({ name: k.replace('#1', '') + ' list ' + d }) - 1;
                leafNode.set(k + '|' + d, n);
                const pn = J.nodes[nodeOf.get(k)];
                (pn.children = pn.children || []).push(n);
            }
        }
        // Skin: joints in node order, each inverse bind standing at its pivot.
        const jointList = [...nodeOf.values(), ...leafNode.values()];
        const jointIndex = new Map(jointList.map((n, i) => [n, i]));
        const pivotOfNode = new Map();
        for (const j of B.joints.values()) pivotOfNode.set(nodeOf.get(j.key), j.pivot);
        for (const [lk, n] of leafNode) pivotOfNode.set(n, B.joints.get(lk.split('|')[0]).pivot);
        const ibm = new Float32Array(jointList.length * 16);
        jointList.forEach((n, i) => {
            const p = pivotOfNode.get(n);
            ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -p[0], -p[1], -p[2], 1], i * 16);
        });
        const ibmAcc = g.accessor(ibm, 'MAT4', 5126);
        J.skins = [{ joints: jointList, inverseBindMatrices: ibmAcc, skeleton: rootNode }];
        // Mesh: a primitive per material, vertices in model space (the rest pose is the stored mesh).
        const prims = new Map();
        for (const [tag, tris] of B.meshTris) {
            const [k] = tag.split('|');
            const node = leafNode.get(tag) !== undefined ? leafNode.get(tag) : nodeOf.get(k), ji = jointIndex.get(node);
            for (const t of tris) {
                const unlit = !t.verts[0].litAtLoad, id = g.material(t.material, unlit);
                if (!prims.has(id)) prims.set(id, { id, mat: t.material, unlit, verts: new Map(), list: [], index: [] });
                const P = prims.get(id);
                const img = t.material.tex0 ? g.image(t.material.tex0) : null;
                for (const v of t.verts) {
                    const uv = img ? vertexUV(t.material.tex0, img, v.s, v.t) : [0, 0];
                    const extra = unlit ? (v.col || [255, 255, 255, 255]).join() : (v.nrm || [0, 0, 0]).join();
                    const vk = [v.raw.join(), ji, uv[0].toFixed(5), uv[1].toFixed(5), extra].join('/');
                    let i = P.verts.get(vk);
                    if (i === undefined) { i = P.list.length; P.verts.set(vk, i); P.list.push({ raw: v.raw, ji, uv, col: v.col, nrm: v.nrm }); }
                    P.index.push(i);
                }
            }
        }
        const primitives = [];
        for (const P of prims.values()) {
            const n = P.list.length, pos = new Float32Array(n * 3), uv = new Float32Array(n * 2), jo = new Uint16Array(n * 4), we = new Float32Array(n * 4), idx = n > 65535 ? new Uint32Array(P.index) : new Uint16Array(P.index);
            const col = P.unlit ? new Float32Array(n * 4) : null, nrm = P.unlit ? null : new Float32Array(n * 3);
            P.list.forEach((v, i) => {
                pos.set(v.raw, i * 3); uv.set(v.uv, i * 2); jo[i * 4] = v.ji; we[i * 4] = 1;
                if (col) { const c = v.col || [255, 255, 255, 255]; col.set([toLinear(c[0] / 255), toLinear(c[1] / 255), toLinear(c[2] / 255), c[3] / 255], i * 4); }
                if (nrm) {     // a few vertices store (0, 0, 0), which glTF does not allow: they take a default
                    const a = v.nrm && (v.nrm[0] || v.nrm[1] || v.nrm[2]) ? v.nrm : [0, 127, 0], l = Math.hypot(a[0], a[1], a[2]);
                    nrm.set([a[0] / l, a[1] / l, a[2] / l], i * 3);
                }
            });
            const attributes = { POSITION: g.accessorBounds(pos, 'VEC3', 5126, 34962), TEXCOORD_0: g.accessor(uv, 'VEC2', 5126, 34962), JOINTS_0: g.accessor(jo, 'VEC4', 5123, 34962), WEIGHTS_0: g.accessor(we, 'VEC4', 5126, 34962) };
            if (col) attributes.COLOR_0 = g.accessor(col, 'VEC4', 5126, 34962);
            if (nrm) attributes.NORMAL = g.accessor(nrm, 'VEC3', 5126, 34962);
            primitives.push({ attributes, indices: g.accessor(idx, 'SCALAR', n > 65535 ? 5125 : 5123, 34963), material: P.id });
        }
        J.meshes.push({ name: B.name, primitives });
        const meshNode = J.nodes.push({ name: B.name + ' mesh', mesh: 0, skin: 0 }) - 1;
        J.scenes[0].nodes.push(rootNode, meshNode);
        // Animations
        J.animations = [];
        const roundedSame = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
        for (const clip of B.clips) {
            const channels = [], samplers = [];
            const add = (node, path, input, output, type, interpolation) => {
                samplers.push({ input, output, interpolation });
                channels.push({ sampler: samplers.length - 1, target: { node, path } });
            };
            const times = new Float32Array(clip.samples.map((_, i) => i / 30));
            const input = g.accessorBounds(times, 'SCALAR', 5126);
            const single = g.accessorBounds(new Float32Array([0]), 'SCALAR', 5126);
            for (const [k, list] of clip.tracks) {
                const node = nodeOf.get(k);
                const rots = list.map(t => t.r.slice());
                for (let i = 1; i < rots.length; i++) if (rots[i][0] * rots[i - 1][0] + rots[i][1] * rots[i - 1][1] + rots[i][2] * rots[i - 1][2] + rots[i][3] * rots[i - 1][3] < 0) rots[i] = rots[i].map(v => -v);
                const write = (path, values, size, type) => {
                    const constant = values.every(v => roundedSame(v, values[0]));
                    const data = new Float32Array((constant ? 1 : values.length) * size);
                    (constant ? [values[0]] : values).forEach((v, i) => data.set(v, i * size));
                    add(node, path, constant ? single : input, g.accessor(data, type, 5126), type, 'LINEAR');
                };
                write('translation', list.map(t => t.t), 3, 'VEC3');
                write('rotation', rots, 4, 'VEC4');
                write('scale', list.map(t => t.s), 3, 'VEC3');
                if (helperOf.has(k)) {
                    const hn = helperOf.get(k), hs = list.map(t => t.helper || { t: [0, 0, 0], r: [0, 0, 0, 1], s: [1, 1, 1] });
                    const hr = hs.map(t => t.r.slice());
                    for (let i = 1; i < hr.length; i++) if (hr[i][0] * hr[i - 1][0] + hr[i][1] * hr[i - 1][1] + hr[i][2] * hr[i - 1][2] + hr[i][3] * hr[i - 1][3] < 0) hr[i] = hr[i].map(v => -v);
                    const writeH = (path, values, size, type) => {
                        const constant = values.every(v => roundedSame(v, values[0]));
                        const data = new Float32Array((constant ? 1 : values.length) * size);
                        (constant ? [values[0]] : values).forEach((v, i) => data.set(v, i * size));
                        add(hn, path, constant ? single : input, g.accessor(data, type, 5126), type, 'LINEAR');
                    };
                    writeH('translation', hs.map(t => t.t), 3, 'VEC3');
                    writeH('rotation', hr, 4, 'VEC4');
                    writeH('scale', hs.map(t => t.s), 3, 'VEC3');
                }
            }
            for (const [lk, flagsList] of clip.leafs) {
                const data = new Float32Array(flagsList.length * 3);
                flagsList.forEach((v, i) => data.set([v, v, v], i * 3));
                add(leafNode.get(lk), 'scale', input, g.accessor(data, 'VEC3', 5126), 'VEC3', 'STEP');
            }
            J.animations.push({ name: clip.name, channels, samplers });
        }
        return g.finish();
    }

    // ---------------------------------------------------------------- a room: world-space triangles, indexed per material

    /** captured: triangles from an Rsp with capture on (world x, y, z and baked shade in each vertex). markers: named empties. */
    function roomToGlb(name, captured, markers) {
        const g = new Glb('Eltale Model Viewer'), J = g.json;
        const prims = new Map();
        for (const t of captured) {
            const id = g.material(t.material, true);
            if (!prims.has(id)) prims.set(id, { id, verts: new Map(), list: [], index: [] });
            const P = prims.get(id), img = t.material.tex0 ? g.image(t.material.tex0) : null;
            for (const v of t.verts) {
                const uv = img ? vertexUV(t.material.tex0, img, v.s, v.t) : [0, 0];
                const vk = [v.x.toFixed(3), v.y.toFixed(3), v.z.toFixed(3), uv[0].toFixed(5), uv[1].toFixed(5), v.r.toFixed(1), v.g.toFixed(1), v.b.toFixed(1), v.a].join('/');
                let i = P.verts.get(vk);
                if (i === undefined) { i = P.list.length; P.verts.set(vk, i); P.list.push({ p: [v.x, v.y, v.z], uv, c: [toLinear(v.r / 255), toLinear(v.g / 255), toLinear(v.b / 255), v.a / 255] }); }
                P.index.push(i);
            }
        }
        const primitives = [];
        for (const P of prims.values()) {
            const n = P.list.length, pos = new Float32Array(n * 3), uv = new Float32Array(n * 2), col = new Float32Array(n * 4), idx = n > 65535 ? new Uint32Array(P.index) : new Uint16Array(P.index);
            P.list.forEach((v, i) => { pos.set(v.p, i * 3); uv.set(v.uv, i * 2); col.set(v.c, i * 4); });
            primitives.push({ attributes: { POSITION: g.accessorBounds(pos, 'VEC3', 5126, 34962), TEXCOORD_0: g.accessor(uv, 'VEC2', 5126, 34962), COLOR_0: g.accessor(col, 'VEC4', 5126, 34962) }, indices: g.accessor(idx, 'SCALAR', n > 65535 ? 5125 : 5123, 34963), material: P.id });
        }
        J.meshes.push({ name, primitives });
        const meshNode = J.nodes.push({ name: name + ' mesh', mesh: 0 }) - 1;
        const children = [meshNode];
        for (const m of markers || []) children.push(J.nodes.push({ name: m.name, translation: [m.x, m.y, m.z] }) - 1);
        J.scenes[0].nodes.push(J.nodes.push({ name, scale: [EXPORT_SCALE, EXPORT_SCALE, EXPORT_SCALE], children }) - 1);
        return g.finish();
    }

    // ---------------------------------------------------------------- OBJ: a static pose or room

    /** Triangles to a zip of OBJ, MTL and PNGs. OBJ has no vertex colours or mirrored sampler: PRIM goes to Kd, mirrored tiles are doubled. */
    function trianglesToObjZip(name, captured) {
        const files = [], materials = new Map(), images = new Map();
        const verts = [], uvs = [], faces = [], stem = name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
        const vtIndex = new Map(), vIndex = new Map();
        const addImage = tex => {
            if (images.has(tex.key)) return images.get(tex.key);
            const img = tileImage(tex);
            const mirrorS = img.wrapS === 33648, mirrorT = img.wrapT === 33648;
            const w = img.w * (mirrorS ? 2 : 1), h = img.h * (mirrorT ? 2 : 1), px = new Uint8Array(w * h * 4);
            for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
                const sx = x < img.w ? x : w - 1 - x, sy = y < img.h ? y : h - 1 - y, i = (sy * img.w + sx) * 4, o = (y * w + x) * 4;
                px[o] = img.px[i]; px[o + 1] = img.px[i + 1]; px[o + 2] = img.px[i + 2]; px[o + 3] = img.px[i + 3];
            }
            const file = 'tex_' + tex.data.hash.toString(16).padStart(8, '0') + '_' + w + 'x' + h + (mirrorS ? 'm' : '') + (mirrorT ? 'n' : '') + '.png';
            if (!files.some(f => f[0] === file)) files.push([file, encodePng(w, h, px)]);
            const out = { img, file, du: mirrorS ? 0.5 : 1, dv: mirrorT ? 0.5 : 1 };
            images.set(tex.key, out);
            return out;
        };
        const lines = [];
        let current = null;
        for (const t of captured) {
            const key = t.material.key;
            if (!materials.has(key)) materials.set(key, { name: 'mat_' + materials.size, mat: t.material, img: t.material.tex0 ? addImage(t.material.tex0) : null });
            const M = materials.get(key);
            if (current !== key) { current = key; lines.push('usemtl ' + M.name); }
            const ids = t.verts.map(v => {
                const pk = [v.x.toFixed(3), v.y.toFixed(3), v.z.toFixed(3)].join();
                if (!vIndex.has(pk)) { vIndex.set(pk, vIndex.size + 1); verts.push(`v ${(v.x * EXPORT_SCALE).toFixed(5)} ${(v.y * EXPORT_SCALE).toFixed(5)} ${(v.z * EXPORT_SCALE).toFixed(5)}`); }
                let u = 0, w = 0;
                if (M.img) { const uv = vertexUV(t.material.tex0, M.img.img, v.s, v.t); u = uv[0] * M.img.du; w = 1 - uv[1] * M.img.dv; }     // OBJ's texture origin is bottom-left
                const tk = u.toFixed(5) + ' ' + w.toFixed(5);
                if (!vtIndex.has(tk)) { vtIndex.set(tk, vtIndex.size + 1); uvs.push('vt ' + tk); }
                return vIndex.get(pk) + '/' + vtIndex.get(tk);
            });
            lines.push('f ' + ids.join(' '));
        }
        const mtl = [];
        for (const M of materials.values()) {
            const f = combinerFactor(M.mat);
            mtl.push('newmtl ' + M.name, `Kd ${toLinear(f[0]).toFixed(4)} ${toLinear(f[1]).toFixed(4)} ${toLinear(f[2]).toFixed(4)}`, 'Ka 0 0 0', 'Ks 0 0 0', 'illum 1');
            if (M.mat.blend) mtl.push('d ' + f[3].toFixed(4));
            if (M.img) { mtl.push('map_Kd ' + M.img.file); if (M.mat.cutout) mtl.push('map_d ' + M.img.file); }
            mtl.push('');
        }
        const enc = s => new TextEncoder().encode(s);
        files.unshift([stem + '.mtl', enc(mtl.join('\n'))]);
        files.unshift([stem + '.obj', enc(['mtllib ' + stem + '.mtl', ...verts, ...uvs, ...lines, ''].join('\n'))]);
        return makeZip(files);
    }

    // ---------------------------------------------------------------- GIF

    /** Up to n colours by median cut, from a histogram over 32,768 five-bit colours. */
    function gifPalette(hist, n) {
        let boxes = [[]];
        for (let c = 0; c < 32768; c++) if (hist[c]) boxes[0].push(c);
        if (!boxes[0].length) boxes[0].push(0);
        const ch = (c, i) => (c >> (i * 5)) & 31;
        while (boxes.length < n) {
            let best = -1, axis = 0, spread = 0;
            boxes.forEach((b, i) => {
                if (b.length < 2) return;
                for (let a = 0; a < 3; a++) {
                    let lo = 31, hi = 0;
                    for (const c of b) { const v = ch(c, a); if (v < lo) lo = v; if (v > hi) hi = v; }
                    if (hi - lo > spread) { spread = hi - lo; best = i; axis = a; }
                }
            });
            if (best < 0) break;
            const b = boxes[best].sort((p, q) => ch(p, axis) - ch(q, axis));
            let total = 0, run = 0, cut = 1;
            for (const c of b) total += hist[c];
            for (let i = 0; i < b.length - 1; i++) { run += hist[b[i]]; cut = i + 1; if (run * 2 >= total) break; }
            boxes.splice(best, 1, b.slice(0, cut), b.slice(cut));
        }
        return boxes.map(b => {
            let w = 0, s = [0, 0, 0];
            for (const c of b) { const k = hist[c] || 1; w += k; for (let a = 0; a < 3; a++) s[a] += ch(c, a) * k; }
            return [0, 1, 2].map(a => Math.round(s[a] / w * 255 / 31));
        });
    }

    /** A looping GIF, written a frame at a time: long animations at 640 x 480 stay small in memory. */
    class GifWriter {
        constructor(w, h, palette, delayCs, transparentIndex) {
            this.w = w; this.h = h; this.delay = delayCs; this.transparent = transparentIndex;
            const pal = new Uint8Array(768);
            palette.forEach((c, i) => pal.set(c, i * 3));
            this.parts = [ascii('GIF89a'), Uint8Array.of(w & 255, w >> 8, h & 255, h >> 8, 0xF7, 0, 0), pal,
                Uint8Array.of(0x21, 0xFF, 11), ascii('NETSCAPE2.0'), Uint8Array.of(3, 1, 0, 0, 0)];
        }
        addFrame(indices) {
            const { w, h } = this, tr = this.transparent;
            this.parts.push(Uint8Array.of(0x21, 0xF9, 4, tr >= 0 ? 0x09 : 0x04, this.delay & 255, this.delay >> 8, tr >= 0 ? tr : 0, 0));
            this.parts.push(Uint8Array.of(0x2C, 0, 0, 0, 0, w & 255, w >> 8, h & 255, h >> 8, 0, 8));
            // LZW, least significant bit first, in sub-blocks of up to 255 bytes
            const clear = 256, end = 257, out = [];
            let acc = 0, bits = 0, block = [], size = 9, next = 258, table = new Map();
            const put = code => {
                acc |= code << bits; bits += size;
                while (bits >= 8) {
                    block.push(acc & 255); acc >>>= 8; bits -= 8;
                    if (block.length === 255) { out.push(255, ...block); block = []; }
                }
            };
            put(clear);
            let cur = indices[0];
            for (let i = 1; i < indices.length; i++) {
                const k = indices[i], key = cur * 256 + k, hit = table.get(key);
                if (hit !== undefined) { cur = hit; continue; }
                put(cur);
                if (next < 4096) {
                    table.set(key, next);
                    if (next === (1 << size) && size < 12) size++;
                    next++;
                } else { put(clear); table = new Map(); size = 9; next = 258; }
                cur = k;
            }
            put(cur);
            put(end);
            if (bits) block.push(acc & 255);
            if (block.length) out.push(block.length, ...block);
            out.push(0);
            this.parts.push(Uint8Array.from(out));
        }
        finish() { this.parts.push(Uint8Array.of(0x3B)); return concat(this.parts); }
    }

    root.ModelExport = { gifPalette, GifWriter, partLists, EXPORT_SCALE, toLinear, encodePng, makeZip, crc32, tileImage, tileCoord, vertexUV, combinerFactor, buildModel, modelToGlb, roomToGlb, trianglesToObjZip, trsMatrix, full, IDENTITY, translate };
})(globalThis);
