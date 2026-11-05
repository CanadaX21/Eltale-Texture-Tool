// The working folder: where replaced textures live until a ROM is built from them.
//
// In a browser that can open a real folder (Edge, Chrome), that folder holds:
//     import/   the replacement PNGs, under the names the importer needs. Edit them there if you like: the page rereads them when it gets focus.
//     export/   what Export all writes
//     build/    the new ROM and its report
// import/ is an ordinary mod folder: the Python Texture Tool can build from it too. Without a chosen folder, or in a browser that can't open one, the
// replacements live in this browser's own storage, and exports and ROMs come as downloads.
(function (root) {
    'use strict';
    const DB = 'eltale-tool';

    function open() {
        return new Promise((ok, no) => {
            const r = indexedDB.open(DB, 2);
            r.onupgradeneeded = () => { for (const s of ['files', 'imports']) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s); };
            r.onsuccess = () => ok(r.result);
            r.onerror = () => no(r.error);
        });
    }
    async function act(store, mode, fn) {
        const db = await open();
        try {
            return await new Promise((ok, no) => {
                const tx = db.transaction(store, mode), q = fn(tx.objectStore(store));
                tx.oncomplete = () => ok(q && q.result);
                tx.onerror = tx.onabort = () => no(tx.error);
            });
        } finally { db.close(); }
    }
    const isPng = name => name.toLowerCase().endsWith('.png');

    class Workspace {
        constructor() { this.dir = null; this.waiting = null; this.usable = true; }
        get canChoose() { return typeof root.showDirectoryPicker === 'function'; }
        get label() { return this.dir ? this.dir.name || 'working folder' : this.waiting ? this.waiting.name : ''; }

        /** The folder from last time. Browsers may want a click before they give it back: see reconnect. */
        async init() {
            try {
                const h = await act('files', 'readonly', s => s.get('workdir'));
                if (!h) return;
                if (await h.queryPermission({ mode: 'readwrite' }) === 'granted') this.dir = h;
                else this.waiting = h;
            } catch (e) { this.usable = false; }
        }
        async reconnect() {
            if (!this.waiting) return false;
            if (await this.waiting.requestPermission({ mode: 'readwrite' }) !== 'granted') return false;
            this.dir = this.waiting; this.waiting = null;
            await this.moveIn();
            return true;
        }
        /** handle: from showDirectoryPicker. Anything kept in the browser moves into it; a file already there wins. */
        async use(handle) {
            this.dir = handle; this.waiting = null;
            await act('files', 'readwrite', s => s.put(handle, 'workdir'));
            await this.moveIn();
        }
        async leaveFolder() {
            this.dir = null; this.waiting = null;
            await act('files', 'readwrite', s => s.delete('workdir'));
        }
        async moveIn() {
            let kept = {};
            try { kept = (await act('files', 'readonly', s => s.get('tints'))) || {}; } catch (e) { /* none */ }
            if (Object.keys(kept).length) {
                await this.setTints(Object.assign(kept, await this.getTints()));
                await act('files', 'readwrite', s => s.delete('tints'));
            }
            await this.movePngsIn();
        }
        async movePngsIn() {
            const kept = await this.browserList();
            if (!kept.length) return;
            const there = new Set((await this.list()).map(f => f.path));
            for (const f of kept) {
                if (!there.has(f.path)) await this.writeOut('import/' + f.path, f.bytes);
                await act('imports', 'readwrite', s => s.delete(f.path));
            }
        }

        async browserList() {
            try {
                const db = await open();
                try {
                    return await new Promise((ok, no) => {
                        const out = [], c = db.transaction('imports').objectStore('imports').openCursor();
                        c.onsuccess = () => { const k = c.result; if (!k) return ok(out); out.push({ path: String(k.key), bytes: k.value, stamp: k.value.length }); k.continue(); };
                        c.onerror = () => no(c.error);
                    });
                } finally { db.close(); }
            } catch (e) { this.usable = false; return this.memory ? [...this.memory.values()] : []; }
        }

        /** The replacement PNGs: [{ path relative to import/, bytes, stamp }]. */
        async list() {
            if (!this.dir) return this.browserList();
            let folder;
            try { folder = await this.dir.getDirectoryHandle('import'); } catch (e) { return []; }
            const out = [];
            const walk = async (d, prefix) => {
                for await (const [name, h] of d.entries()) {
                    if (h.kind === 'directory') await walk(h, prefix + name + '/');
                    else if (isPng(name)) {
                        const file = await h.getFile();
                        out.push({ path: prefix + name, bytes: new Uint8Array(await file.arrayBuffer()), stamp: file.lastModified + ':' + file.size });
                    }
                }
            };
            await walk(folder, '');
            return out;
        }

        async put(name, bytes) {
            if (this.dir) return this.writeOut('import/' + name, bytes);
            const copy = bytes.slice();
            try { await act('imports', 'readwrite', s => s.put(copy, name)); }
            catch (e) { this.usable = false; (this.memory = this.memory || new Map()).set(name, { path: name, bytes: copy, stamp: copy.length }); }
        }
        async remove(path) {
            if (!this.dir) {
                if (this.memory) this.memory.delete(path);
                try { await act('imports', 'readwrite', s => s.delete(path)); } catch (e) { /* it was only in memory */ }
                return;
            }
            let d = await this.dir.getDirectoryHandle('import');
            const parts = path.split('/'), last = parts.pop();
            for (const p of parts) d = await d.getDirectoryHandle(p);
            await d.removeEntry(last);
        }
        /** Colour edits: { "ROM offset of an 0xFA command in hex": [r, g, b] }. A file of its own: import/ stays PNGs, which the Python tool can read. */
        async getTints() {
            try {
                if (this.dir) {
                    const f = await (await this.dir.getFileHandle('tints.json')).getFile();
                    return JSON.parse(await f.text());
                }
                return (await act('files', 'readonly', s => s.get('tints'))) || {};
            } catch (e) { return this.memoryTints || {}; }
        }
        async setTints(t) {
            if (this.dir) return this.writeOut('tints.json', new TextEncoder().encode(JSON.stringify(t, null, 1)));
            this.memoryTints = t;
            try { await act('files', 'readwrite', s => s.put(t, 'tints')); } catch (e) { /* kept in memory */ }
        }
        /** A file anywhere under the chosen folder. */
        async writeOut(path, bytes) {
            let d = this.dir;
            const parts = path.split('/'), last = parts.pop();
            for (const p of parts) d = await d.getDirectoryHandle(p, { create: true });
            const w = await (await d.getFileHandle(last, { create: true })).createWritable();
            await w.write(bytes);
            await w.close();
        }
    }
    root.Workspace = Workspace;
    root.ToolStore = { open };
})(globalThis);
