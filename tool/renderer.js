// WebGL2 drawing for the viewer: triangles and materials from model_core.js's Rsp, one shader per colour combiner.
// Texture sampling is done in the shader the way the RDP does it (clamp, then mirror / wrap by mask; three-point
// filtering), because GL's own wrap modes cannot express a mask smaller than the image or a clamp at the tile's edge.
(function (root) {
    'use strict';

    const VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec4 aShade;
layout(location=2) in vec2 aST;
uniform mat4 uViewProj;
uniform mat4 uFogClip;      // world to the game's own clip space: fog follows the game's z, not the viewer's
uniform vec2 uFogRange;
out vec4 vShade;
out vec2 vST;
out float vFog;
void main() {
    vShade = aShade; vST = aST;
    vec4 f = uFogClip * vec4(aPos, 1.0);
    // gSPFogPosition, per vertex as the RSP does it. Divided by |w|: a vertex behind the camera has no fog, which is what a real frame shows.
    vFog = clamp((f.z / abs(f.w) * 500.0 + 500.0 - uFogRange.x) / (uFogRange.y - uFogRange.x), 0.0, 1.0);
    gl_Position = uViewProj * vec4(aPos, 1.0);
}`;

    const SRC_RGB = {
        COMBINED: 'comb.rgb', T0: 't0.rgb', T1: 't1.rgb', PRIM: 'uPrim.rgb', SHADE: 'vShade.rgb', ENV: 'uEnv.rgb', ONE: 'vec3(1.0)', ZERO: 'vec3(0.0)',
        NOISE: 'vec3(0.5)', CENTER: 'vec3(0.0)', K4: 'vec3(0.0)', SCALE: 'vec3(0.0)', COMBINED_A: 'vec3(comb.a)', T0_A: 'vec3(t0.a)', T1_A: 'vec3(t1.a)',
        PRIM_A: 'vec3(uPrim.a)', SHADE_A: 'vec3(vShade.a)', ENV_A: 'vec3(uEnv.a)', LOD: 'vec3(0.0)', PRIM_LOD: 'vec3(1.0)', K5: 'vec3(0.0)',
    };
    const SRC_A = {
        COMBINED: 'comb.a', T0: 't0.a', T1: 't1.a', PRIM: 'uPrim.a', SHADE: 'vShade.a', ENV: 'uEnv.a', ONE: '1.0', ZERO: '0.0', LOD: '0.0', PRIM_LOD: '1.0',
    };

    function fragmentSource(mat) {
        const cyc = q => `
    col = (${SRC_RGB[q.a]} - ${SRC_RGB[q.b]}) * ${SRC_RGB[q.c]} + ${SRC_RGB[q.d]};
    al = (${SRC_A[q.Aa]} - ${SRC_A[q.Ab]}) * ${SRC_A[q.Ac]} + ${SRC_A[q.Ad]};
    comb = clamp(vec4(col, al), 0.0, 1.0);`;
        return `#version 300 es
precision highp float;
precision highp sampler2D;
in vec4 vShade;
in vec2 vST;
in float vFog;
out vec4 outColor;
uniform vec4 uPrim, uEnv;
uniform vec3 uFogColour;
uniform float uFogOn;
uniform sampler2D uTex0, uTex1;
uniform ivec4 uInfo0, uInfo1;   // tile width, tile height, mask width (0 = none), mask height
uniform ivec2 uMode0, uMode1;   // cms, cmt: bit 0 mirror, bit 1 clamp
uniform vec4 uUv0, uUv1;        // shift scale s, t, tile origin s, t
uniform int uFilter;
uniform float uCutout, uKeepAlpha;
int coord(int c, int size, int mask, int mode) {
    if ((mode & 2) != 0 || mask == 0) c = clamp(c, 0, size - 1);
    if (mask != 0) {
        if ((mode & 1) != 0 && (c & mask) != 0) c = ~c;
        c &= mask - 1;
    }
    return c;
}
vec4 fetch(sampler2D t, ivec2 p, ivec4 info, ivec2 mode) {
    return texelFetch(t, ivec2(coord(p.x, info.x, info.z, mode.x), coord(p.y, info.y, info.w, mode.y)), 0);
}
vec4 sampleTile(sampler2D t, ivec4 info, ivec2 mode, vec4 uv) {
    vec2 st = vST * uv.xy - uv.zw;
    ivec2 b = ivec2(floor(st));
    if (uFilter == 0) return fetch(t, b, info, mode);
    vec2 f = st - floor(st);                         // the RDP's three-point filter
    vec4 c0 = fetch(t, b, info, mode);
    vec4 cs = fetch(t, b + ivec2(1, 0), info, mode);
    vec4 ct = fetch(t, b + ivec2(0, 1), info, mode);
    if (f.x + f.y >= 1.0) {
        vec4 c1 = fetch(t, b + ivec2(1, 1), info, mode);
        return c1 + (1.0 - f.x) * (ct - c1) + (1.0 - f.y) * (cs - c1);
    }
    return c0 + f.x * (cs - c0) + f.y * (ct - c0);
}
void main() {
    vec4 t0 = ${mat.tex0 ? 'sampleTile(uTex0, uInfo0, uMode0, uUv0)' : 'vec4(1.0)'};
    vec4 t1 = ${mat.tex1 ? 'sampleTile(uTex1, uInfo1, uMode1, uUv1)' : 'vec4(1.0)'};
    vec4 comb = vec4(0.0);
    vec3 col; float al;
    ${cyc(mat.combine.c0)}
    ${mat.two ? cyc(mat.combine.c1) : ''}
    if (uCutout > 0.0 && comb.a < uCutout) discard;
    outColor = vec4(mix(comb.rgb, uFogColour, uFogOn * vFog), uKeepAlpha > 0.5 ? comb.a : 1.0);    // the canvas's alpha is what a transparent picture saves
}`;
    }

    class Renderer {
        constructor(canvas) {
            const gl = canvas.getContext('webgl2', { antialias: true, preserveDrawingBuffer: true, alpha: true, premultipliedAlpha: false });
            if (!gl) throw new Error('This browser does not offer WebGL2.');
            this.gl = gl; this.canvas = canvas;
            this.programs = new Map(); this.textures = new Map();
            this.vao = gl.createVertexArray(); this.vbo = gl.createBuffer();
            gl.bindVertexArray(this.vao);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
            const stride = 9 * 4;
            gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
            gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 12);
            gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 28);
            gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
            // A room's triangles live here, uploaded once: re-sending thousands a frame would not keep up.
            this.staticVao = gl.createVertexArray(); this.staticVbo = gl.createBuffer();
            gl.bindVertexArray(this.staticVao);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.staticVbo);
            gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
            gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 12);
            gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 28);
            gl.bindVertexArray(this.vao);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
            this.lineProgram = this.link(VS.replace('vST = aST;', ''), `#version 300 es
precision highp float; in vec4 vShade; out vec4 c; void main() { c = vShade; }`);
            this.lineLoc = gl.getUniformLocation(this.lineProgram, 'uViewProj');
            this.filter = true; this.cull = true; this.n64Depth = true; this.fixedSize = null; this.fog = null;
        }
        link(vs, fs) {
            const gl = this.gl, p = gl.createProgram();
            for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
                const s = gl.createShader(type);
                gl.shaderSource(s, src); gl.compileShader(s);
                if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('Shader: ' + gl.getShaderInfoLog(s));
                gl.attachShader(p, s);
            }
            gl.linkProgram(p);
            if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Link: ' + gl.getProgramInfoLog(p));
            return p;
        }
        program(mat) {
            const key = [mat.combine.c0, mat.two ? mat.combine.c1 : 0, !!mat.tex0, !!mat.tex1].map(v => JSON.stringify(v)).join();
            let e = this.programs.get(key);
            if (!e) {
                const gl = this.gl, p = this.link(VS, fragmentSource(mat)), u = {};
                for (const n of ['uViewProj', 'uPrim', 'uEnv', 'uTex0', 'uTex1', 'uInfo0', 'uInfo1', 'uMode0', 'uMode1', 'uUv0', 'uUv1', 'uFilter', 'uCutout', 'uKeepAlpha', 'uFogClip', 'uFogRange', 'uFogColour', 'uFogOn']) u[n] = gl.getUniformLocation(p, n);
                e = { p, u };
                this.programs.set(key, e);
            }
            return e;
        }
        texture(tex) {
            const d = tex.data, key = d.hash + ':' + d.w + 'x' + d.h;
            let t = this.textures.get(key);
            if (!t) {
                const gl = this.gl;
                if (this.textures.size > 4000) {      // walking through every room would otherwise keep them all
                    for (const old of this.textures.values()) gl.deleteTexture(old);
                    this.textures.clear();
                }
                t = gl.createTexture();
                gl.bindTexture(gl.TEXTURE_2D, t);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, d.w, d.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, d.px);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
                this.textures.set(key, t);
            }
            return t;
        }
        resize() {
            const dpr = window.devicePixelRatio || 1, c = this.canvas;
            const w = this.fixedSize ? this.fixedSize[0] : Math.max(1, Math.round(c.clientWidth * dpr)), h = this.fixedSize ? this.fixedSize[1] : Math.max(1, Math.round(c.clientHeight * dpr));
            if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
            return w / h;
        }
        /** Put batches in the GPU's static buffer. draw() then draws them by range. */
        upload(batches) {
            let n = 0;
            for (const b of batches) n += b.data.length;
            const all = new Float32Array(n), gl = this.gl;
            let o = 0;
            for (const b of batches) { all.set(b.data, o); b.first = o / 9; b.count = b.data.length / 9; o += b.data.length; }
            gl.bindBuffer(gl.ARRAY_BUFFER, this.staticVbo);
            gl.bufferData(gl.ARRAY_BUFFER, all, gl.STATIC_DRAW);
        }
        begin(bg, alpha = 1) {
            const gl = this.gl;
            gl.viewport(0, 0, this.canvas.width, this.canvas.height);
            gl.depthMask(true);
            gl.clearColor(bg[0], bg[1], bg[2], alpha);
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
            gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
        }
        draw(batches, viewProj) {
            const gl = this.gl;
            for (const b of batches) {
                const mat = b.material, { p, u } = this.program(mat);
                gl.useProgram(p);
                gl.uniformMatrix4fv(u.uViewProj, false, viewProj);
                gl.uniform4f(u.uPrim, mat.prim[0] / 255, mat.prim[1] / 255, mat.prim[2] / 255, mat.prim[3] / 255);
                gl.uniform4f(u.uEnv, mat.env[0] / 255, mat.env[1] / 255, mat.env[2] / 255, mat.env[3] / 255);
                gl.uniform1i(u.uFilter, this.filter && mat.filter !== 0 ? 1 : 0);
                gl.uniform1f(u.uCutout, mat.cutout ? 0.5 : 0);
                gl.uniform1f(u.uKeepAlpha, mat.blend ? 1 : 0);
                if (this.fog && mat.fog) {
                    gl.uniform1f(u.uFogOn, 1);
                    gl.uniformMatrix4fv(u.uFogClip, false, this.fog.clip);
                    gl.uniform2f(u.uFogRange, this.fog.near, Math.max(this.fog.far, this.fog.near + 1));
                    gl.uniform3f(u.uFogColour, this.fog.colour[0] / 255, this.fog.colour[1] / 255, this.fog.colour[2] / 255);
                } else gl.uniform1f(u.uFogOn, 0);
                [[mat.tex0, 0], [mat.tex1, 1]].forEach(([t, i]) => {
                    if (!t) return;
                    gl.activeTexture(gl.TEXTURE0 + i);
                    gl.bindTexture(gl.TEXTURE_2D, this.texture(t));
                    gl.uniform1i(u['uTex' + i], i);
                    gl.uniform4i(u['uInfo' + i], t.data.tileW, t.data.tileH, t.masks ? 1 << t.masks : 0, t.maskt ? 1 << t.maskt : 0);
                    gl.uniform2i(u['uMode' + i], t.cms, t.cmt);
                    gl.uniform4f(u['uUv' + i], t.scaleS, t.scaleT, t.uls, t.ult);
                });
                if (this.cull && (mat.cullBack || mat.cullFront)) {
                    gl.enable(gl.CULL_FACE);
                    gl.cullFace(mat.cullBack && mat.cullFront ? gl.FRONT_AND_BACK : mat.cullBack ? gl.BACK : gl.FRONT);
                } else gl.disable(gl.CULL_FACE);
                if (mat.blend) { gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA); } else gl.disable(gl.BLEND);
                // N64 depth on: each surface's own z compare, z update and decal offset. Off: a plain depth buffer, with only blended surfaces not writing to it.
                gl.depthMask(this.n64Depth ? mat.zUpdate : !mat.blend);
                gl.depthFunc(this.n64Depth && !mat.zCompare ? gl.ALWAYS : gl.LEQUAL);
                if (this.n64Depth && mat.decal) { gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(-1, -1); } else gl.disable(gl.POLYGON_OFFSET_FILL);
                if (b.first !== undefined) {
                    gl.bindVertexArray(this.staticVao);
                    gl.drawArrays(gl.TRIANGLES, b.first, b.count);
                } else {
                    gl.bindVertexArray(this.vao);
                    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
                    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(b.data), gl.STREAM_DRAW);
                    gl.drawArrays(gl.TRIANGLES, 0, b.data.length / 9);
                }
            }
            gl.depthMask(true);
            gl.depthFunc(gl.LEQUAL);
            gl.disable(gl.POLYGON_OFFSET_FILL);
            gl.disable(gl.BLEND);
        }
        /** The sky never hides what comes after it. */
        clearDepth() { const gl = this.gl; gl.depthMask(true); gl.clear(gl.DEPTH_BUFFER_BIT); }
        /** The picture so far, top row first. */
        read() {
            const gl = this.gl, w = this.canvas.width, h = this.canvas.height, up = new Uint8Array(w * h * 4), out = new Uint8Array(w * h * 4);
            gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, up);
            for (let y = 0; y < h; y++) out.set(up.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
            return out;
        }
        /** Coloured lines on top of the model; points are [x, y, z, r, g, b] pairs. */
        lines(points, viewProj) {
            const gl = this.gl, data = [];
            for (const q of points) data.push(q[0], q[1], q[2], q[3], q[4], q[5], 1, 0, 0);
            gl.useProgram(this.lineProgram);
            gl.uniformMatrix4fv(this.lineLoc, false, viewProj);
            gl.disable(gl.DEPTH_TEST);
            gl.bindVertexArray(this.vao);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STREAM_DRAW);
            gl.drawArrays(gl.LINES, 0, data.length / 9);
            gl.enable(gl.DEPTH_TEST);
        }
    }

    root.Renderer = Renderer;
})(globalThis);
