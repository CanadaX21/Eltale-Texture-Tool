// Eltale model core: reads a model and its animation from a ROM or a RAM dump, poses it, and runs its display lists.
// No DOM and no WebGL here, so the same file runs in the page and in the test (Deno).
// It holds no game data: every byte comes from the file you open.
//
// A plain script, not an ES module: browsers refuse module scripts on file://, and this page is opened from disk.
//
// The maths are ported from the decomp's functions, named next to each one (src/20DA0.c, 27600.c, 27A90.c).
// The microcode is F3DEX 1.23.
(function (root) {
    'use strict';

    const JP_SHA1 = '4161b5c100ec82b0241b20ca8f81366e23564ccb';

    // ---------------------------------------------------------------- the ROM file

    /** Big-endian bytes from .z64, .v64 or .n64. Works on a copy. */
    function normalizeRom(input) {
        const a = new Uint8Array(input);
        if (a.length < 0x1000) throw new Error('This file is too small to be an N64 ROM.');
        const m = (a[0] << 24 | a[1] << 16 | a[2] << 8 | a[3]) >>> 0;
        if (m === 0x80371240) return a;
        if (m === 0x37804012) { for (let i = 0; i + 1 < a.length; i += 2) { const t = a[i]; a[i] = a[i + 1]; a[i + 1] = t; } return a; }
        if (m === 0x40123780) { for (let i = 0; i + 3 < a.length; i += 4) { let t = a[i]; a[i] = a[i + 3]; a[i + 3] = t; t = a[i + 1]; a[i + 1] = a[i + 2]; a[i + 2] = t; } return a; }
        throw new Error('This file does not start like an N64 ROM.');
    }

    /** SHA-1 by hand: crypto.subtle is not dependable on a page opened from disk. */
    function sha1(bytes) {
        const n = bytes.length, words = ((n + 8) >>> 6) + 1, w = new Uint32Array(80);
        let h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
        const tail = new Uint8Array(64 * 2);
        const tailStart = (words - 1 - (((n % 64) + 9 > 64) ? 1 : 0)) * 64;
        tail.set(bytes.subarray(tailStart, n));
        tail[n - tailStart] = 0x80;
        const blocks = (n - tailStart + 9 > 64) ? 2 : 1;
        const hi = Math.floor(n / 0x20000000), lo = (n << 3) >>> 0, end = blocks * 64;
        tail[end - 8] = hi >>> 24; tail[end - 7] = hi >>> 16; tail[end - 6] = hi >>> 8; tail[end - 5] = hi;
        tail[end - 4] = lo >>> 24; tail[end - 3] = lo >>> 16; tail[end - 2] = lo >>> 8; tail[end - 1] = lo;
        const total = tailStart / 64 + blocks;
        for (let b = 0; b < total; b++) {
            const src = b * 64 < tailStart ? bytes : tail, o = b * 64 < tailStart ? b * 64 : b * 64 - tailStart;
            for (let i = 0; i < 16; i++) w[i] = (src[o + i * 4] << 24 | src[o + i * 4 + 1] << 16 | src[o + i * 4 + 2] << 8 | src[o + i * 4 + 3]) >>> 0;
            for (let i = 16; i < 80; i++) { const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]; w[i] = (x << 1 | x >>> 31) >>> 0; }
            let a = h0, bb = h1, c = h2, d = h3, e = h4;
            for (let i = 0; i < 80; i++) {
                let f, k;
                if (i < 20) { f = (bb & c) | (~bb & d); k = 0x5A827999; }
                else if (i < 40) { f = bb ^ c ^ d; k = 0x6ED9EBA1; }
                else if (i < 60) { f = (bb & c) | (bb & d) | (c & d); k = 0x8F1BBCDC; }
                else { f = bb ^ c ^ d; k = 0xCA62C1D6; }
                const t = (((a << 5 | a >>> 27) >>> 0) + (f >>> 0) + e + k + w[i]) >>> 0;
                e = d; d = c; c = (bb << 30 | bb >>> 2) >>> 0; bb = a; a = t;
            }
            h0 = (h0 + a) >>> 0; h1 = (h1 + bb) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
        }
        return [h0, h1, h2, h3, h4].map(v => v.toString(16).padStart(8, '0')).join('');
    }

    // ---------------------------------------------------------------- memory: what the game would have in RAM

    class Mem {
        constructor() { this.regions = []; this.seg = new Uint32Array(16); }
        /** Place bytes at a physical address (RAM address without the 0x80000000). */
        map(phys, bytes, name) {
            this.regions = this.regions.filter(r => r.name !== name);
            this.regions.push({ start: phys, end: phys + bytes.length, bytes, view: new DataView(bytes.buffer, bytes.byteOffset, bytes.length), name });
        }
        /** A display list address (segmented, or 0x80xxxxxx) to physical. */
        phys(a) {
            a = a >>> 0;
            if (a >= 0x80000000) return (a & 0x1FFFFFFF) >>> 0;
            return (this.seg[(a >>> 24) & 15] + (a & 0xFFFFFF)) >>> 0;
        }
        find(p, len) {
            for (const r of this.regions) if (p >= r.start && p + len <= r.end) return r;
            return null;
        }
        has(a, len = 1) { return !!this.find(this.phys(a), len); }
        must(a, len) {
            const p = this.phys(a), r = this.find(p, len);
            if (!r) throw new Error('Address 0x' + (a >>> 0).toString(16) + ' is not loaded.');
            return [r, p - r.start];
        }
        u8(a) { const [r, o] = this.must(a, 1); return r.bytes[o]; }
        s8(a) { const [r, o] = this.must(a, 1); return r.view.getInt8(o); }
        u16(a) { const [r, o] = this.must(a, 2); return r.view.getUint16(o); }
        s16(a) { const [r, o] = this.must(a, 2); return r.view.getInt16(o); }
        u32(a) { const [r, o] = this.must(a, 4); return r.view.getUint32(o); }
        s32(a) { const [r, o] = this.must(a, 4); return r.view.getInt32(o); }
        f32(a) { const [r, o] = this.must(a, 4); return r.view.getFloat32(o); }
        slice(a, len) { const [r, o] = this.must(a, len); return r.bytes.subarray(o, o + len); }
        /** The ROM offset behind an address, when its region is a view of the ROM file itself. */
        romOffset(a, rom) {
            const p = this.phys(a), r = this.find(p, 1);
            return r && r.bytes.buffer === rom.buffer ? r.bytes.byteOffset - rom.byteOffset + p - r.start : -1;
        }
    }

    // ---------------------------------------------------------------- where a monster is met

    // The maps with battles. Labels only: the ROM's own names are Japanese.
    const BATTLE_PLACES = {
        2: 'Holy Plains', 3: 'Dondoran Flats', 5: 'West Carmagh', 7: 'East Limelin', 9: 'Dindom Dries', 11: 'Baragoon Moor', 12: 'Isle of Skye',
        26: 'Blue Cave', 27: 'Cull Hazard', 28: 'Baragoon Tunnel', 29: 'Boil Hole', 30: 'Brannoch Castle', 31: 'Connor Forest', 32: 'Glencoe Forest',
        33: 'Windward Forest', 34: "Mammon's World", 35: "Nepty's lair",
    };

    // Bosses, by boss number (the game's own numbering, which is also the walkthrough's order). Their data is in the cutscene
    // bank, ROM 0xD74AC0-0xD86170 -> RAM 0x8039ADB0: gBossFiles 0x803AB390 (8 B each: ROM start, end), gBossPlacements 0x803AB3D0
    // (0x18 B: map, room, number, pad, animation table), base data 0x803AB820 (0x38 B, as a monster's), gBossAnimTables 0x803ABA58.
    // A boss's file loads to 0x802A7BC0 (LoadMapBoss).
    const BOSSES = {
        names: ['Solvaring', 'Zelse', 'Nepty', 'Sylph', 'Fargo', 'Guilty', 'Beigis', 'Mammon'],
        places: ['Connor Fortress', 'Windward Forest', "Nepty's lair", 'Baragoon Tunnel', 'Boil Hole', 'Brannoch Castle', 'Brannoch Castle', "Mammon's World"],
        bankRam: 0x39ADB0, bankRom: 0xD74AC0, bankEnd: 0xD86170, fileRam: 0x2A7BC0,
        files: 0x803AB390, placements: 0x803AB3D0, base: 0x803AB820, tables: 0x803ABA58,
    };

    /**
     * The battle maps by game area, in walkthrough order. Which maps go together is the game's: its Map page region table
     * (0x80060F30) puts each of these groups under one region image. The order is the guide's (a Quest 64 guide, section 3).
     * Inside a group, maps are in the guide's order too.
     */
    const WALKTHROUGH = [[2, 31], [3, 32], [5, 27, 33, 26], [12], [7, 28], [9, 29], [11, 30], [34]];

    /**
     * The encounter tables, walked as the game does (InitEncounters, RollRandomEncounter, CreateEncounter). Map table ROM
     * 0x577B0, 36 x 0x44: +4 file start, +0xC its RAM, +0x18 submaps (0x18 B, +0x12 = area = the monster set), +0x30 encounter
     * zones per submap (8 B: list, count; a zone is 0x18 B: +8 count, +0xA pack ids), +0x34 (0x10 B per submap, +4 = packs,
     * 8 B each: groups, count; a group is 0xC B, +0 = the monster's ID in the set).
     * Returns { 'set/id': [map, ...] }, by map number.
     */
    function monsterLocations(rom) {
        const u32 = o => (rom[o] << 24 | rom[o + 1] << 16 | rom[o + 2] << 8 | rom[o + 3]) >>> 0;
        const u16 = o => rom[o] << 8 | rom[o + 1];
        const out = {};
        for (let m = 0; m < 36; m++) {
            const e = 0x577B0 + m * 0x44, start = u32(e + 4), ram = u32(e + 0xC), subs = u32(e + 0x18), enc = u32(e + 0x30), cir = u32(e + 0x34);
            if (!enc) continue;
            const R = p => p - ram + start;
            for (let sm = 0; sm < (cir - enc) / 8; sm++) {
                const zones = u32(R(enc) + sm * 8), nz = u32(R(enc) + sm * 8 + 4), packs = u32(R(cir) + sm * 0x10 + 4);
                if (!zones || !packs) continue;      // map 34's rooms 6 and 9 list zones with no pack table: no battles
                const area = u16(R(subs) + sm * 0x18 + 0x12);
                for (let z = 0; z < nz; z++) {
                    const za = R(zones) + z * 0x18;
                    for (let i = 0; i < u16(za + 8); i++) {
                        const pa = R(packs) + u16(za + 10 + 2 * i) * 8, groups = u32(pa);
                        for (let g = 0; g < u16(pa + 4); g++) {
                            const key = area + '/' + u32(R(groups) + g * 12);
                            if (!out[key]) out[key] = [];
                            if (!out[key].includes(m)) out[key].push(m);
                        }
                    }
                }
            }
        }
        return out;
    }

    // ---------------------------------------------------------------- maps: what LoadMap (src/E2A0.c) puts in RAM, and what a room holds

    const MAP_NAMES = ['Melrode', 'Dondoran', 'Holy Plains', 'Dondoran Flats', 'Larapool', 'West Carmagh', 'Normoon', 'East Limelin', 'Limelin',
        'Dindom Dries', 'Shamwood', 'Baragoon Moor', 'Isle of Skye', 'Melrode Monastery', 'Dondoran Castle', 'Melrode buildings', 'Dondoran buildings',
        'Larapool inn', 'West Carmagh buildings', 'Rooms off Normoon', 'Normoon buildings', 'Limelin Castle', 'Limelin buildings', 'Highland buildings',
        'Shamwood (Lavaar)', 'Ship and cabin rooms', 'Blue Cave', 'Cull Hazard', 'Baragoon Tunnel', 'Boil Hole', 'Brannoch Castle', 'Connor Forest',
        'Glencoe Forest', 'Windward Forest', "Mammon's World", "Nepty's lair"];       // labels only

    /**
     * Every map in story order, by the outdoor area it belongs to. A map goes where the story first reaches it, so the ship and cabin
     * rooms come before West Carmagh: the ferry from Dondoran Flats is how you get there. A test checks this against the ROM:
     * each map has a door from one earlier in the list, and the game's boss numbers rise along it.
     */
    const MAP_STORY = [
        { area: 'Holy Plains', maps: [13, 0, 15, 2, 1, 14, 16, 31] },
        { area: 'Dondoran Flats', maps: [3, 32, 25] },
        { area: 'West Carmagh', maps: [5, 4, 17, 18, 27, 6, 19, 20, 33, 26] },
        { area: 'Isle of Skye', maps: [12, 35] },
        { area: 'East Limelin', maps: [7, 8, 21, 22, 28] },
        { area: 'Dindom Dries', maps: [9, 10, 24, 23, 29] },
        { area: 'Baragoon Moor', maps: [11, 30] },
        { area: "Mammon's World", maps: [34] },
    ];

    // NPCs. A map's header +0x38 points at its list: u16 count, then a pointer to records of 0x2C B: +0 room, +4 kind, +5 flags, +0x10 the model
    // (an AnimEntry array), +0x18 talk animation, +0x28 scale. The ROM's names are Japanese; these are labels, by "map/record".
    const NPC_NAMES = {"0/0":"Edgar","0/1":"Kain","0/2":"Sandra","0/3":"Amanda","0/4":"Frank","0/5":"Billy","0/6":"Todd","0/7":"Pete","0/8":"Ralph","0/9":"Sheep","0/10":"Sheep","0/11":"Horse","1/0":"Rufus","1/1":"Katherin","1/2":"Elena","3/0":"Morague","4/0":"Leonitis","4/1":"Russel","4/2":"Ellis","5/0":"Morague","6/0":"Rick","6/1":"Kevin","6/2":"Oscar","7/0":"Morague","8/0":"Nick","8/1":"Jade","8/2":"Sheldon","8/3":"Elgin","8/4":"Roy","11/0":"Shannon","12/0":"Kiliac","13/0":"Auden","13/1":"Gylmyne","13/2":"Marmaduke","13/3":"Pat","13/4":"Cerius","13/5":"Grand Abbott","13/6":"Gelis","13/7":"Fergus","14/0":"Cristole","14/1":"Scottfort","14/2":"Grant","14/3":"Gibson","14/4":"Hew","14/5":"Pasart","14/6":"Felzen","14/7":"Kate","14/8":"Flora","15/0":"Shannon","15/1":"Tim","15/2":"Katie","15/3":"Elspet","15/4":"Agnes","15/5":"Ingram","15/6":"Holly","15/7":"Epona","16/0":"Shannon","16/1":"Shannon","16/2":"Marion","16/3":"Curtis","16/4":"Davy","16/5":"Rocks","16/6":"Clay","16/7":"Annabell","16/8":"Mable","16/9":"Claire","16/10":"Walter","16/11":"Thom","16/12":"Gilbert","16/13":"Steve","16/14":"Maggie","16/15":"Teruma","16/16":"Arkart","17/0":"Shannon","17/1":"Naltese","17/2":"Leila","17/3":"Leila","17/4":"Donovan","17/5":"Alexandir","17/6":"Galita","18/0":"Olden","18/1":"Rosa","18/2":"Camelia","18/3":"Margeret","18/4":"Glion","18/5":"Jiryo","18/6":"Dorothy","18/7":"Lloyd","18/8":"Jeff","18/9":"Efna","20/0":"Shannon","20/1":"Micah","20/2":"Gelus","20/3":"Byson","20/4":"Hector","20/5":"Leonardo","20/6":"Tilly","20/7":"Anette","20/8":"Rysha","21/0":"Deanna","21/1":"William","21/2":"Zing","21/3":"Lenbil","21/4":"Linton","21/5":"Zafa","21/6":"Balu","21/7":"Jared","21/8":"Damon","21/9":"Ian","22/0":"Shannon","22/1":"Dolgo","22/2":"Opal","22/3":"Coral","22/4":"Amber","22/5":"Elle","22/6":"Dio","22/7":"Roach","22/8":"Cindy","22/9":"Rhett","22/10":"Canny","22/11":"Talco","22/12":"Ring","22/13":"Tina","22/14":"Sabastian","23/0":"Shannon","23/1":"Shannon","23/2":"Tom","23/3":"Kolles","23/4":"Stewart","23/5":"Tinvel","23/6":"Hersh","23/7":"Vilgue","23/8":"Valens","23/9":"Andrew","23/10":"Roddy","23/11":"Morris","23/12":"Zonne","23/13":"Ryure","23/14":"Janat","23/15":"Bronze","23/16":"Gelson","23/17":"Walt","23/18":"Edward","23/19":"Bation","24/0":"Lavaar","25/0":"Boren","25/1":"Macren","25/2":"Colleen","25/3":"Kiliac","26/0":"Epona","26/1":"Chappy","30/0":"Shannon","30/1":"Bartholomy","30/2":"Leonardo","32/0":"Kelly","34/0":"Shannon","34/1":"Shannon"};

    /**
     * RAM with an NPC's model in it (LoadNPCArea): its area's blob at 0x8020E6F0, the held objects at 0x8020C0D0, Shannon at 0x802A0000. On top of
     * the map itself, Brian too: he is always loaded, and some NPCs borrow his textures.
     */
    function npcMemory(rom, model) {
        const h = mapHeader(rom, model.users[0].map), mem = mapMemory(rom, h);
        mem.map(0x206000, rom.subarray(0x869620, 0x86F6F0), 'brian');
        mem.map(0x20C0D0, rom.subarray(0x86F6F0, 0x871D10), 'held objects');
        mem.map(0x2A0000, rom.subarray(0xA70350, 0xA77F10), 'shannon');
        if (model.blob) mem.map(0x20E6F0, rom.subarray(model.blob[0], model.blob[1]), 'npc blob');
        return mem;
    }

    /** Every distinct NPC model in story order of where it is first met, from the map headers' lists. The record's model pointer is the split per character. */
    function listNpcModels(rom) {
        const u32 = a => (rom[a] << 24 | rom[a + 1] << 16 | rom[a + 2] << 8 | rom[a + 3]) >>> 0, u16 = a => rom[a] << 8 | rom[a + 1];
        const models = new Map(), story = MAP_STORY.flatMap(g => g.maps);
        for (const m of story) {
            const h = mapHeader(rom, m), o = 0x577B0 + m * 0x44, listAddr = u32(o + 0x38);
            if (!listAddr) continue;
            const R = a => a - h.ram + h.romStart, count = u16(R(listAddr)), list = u32(R(listAddr) + 4);
            for (let i = 0; i < count; i++) {
                const a = R(list) + i * 0x2C, room = u16(a), md = u32(a + 0x10), f = new DataView(rom.buffer, rom.byteOffset + a + 0x28, 4).getFloat32(0);
                const area = u16(R(h.submaps) + room * 0x18 + 0x12);
                const blob = [u32(0x57480 + area * 8), u32(0x57484 + area * 8)];
                const inBlob = md >= 0x8020E6F0 && md < 0x8020E6F0 + blob[1] - blob[0], isShannon = md >= 0x802A0000 && md < 0x802A7BC0;
                const key = inBlob ? 'blob' + area + ':' + md.toString(16) : 'x:' + md.toString(16);
                if (!models.has(key)) models.set(key, { key, md, area, blob: inBlob ? blob : null, shannon: isShannon, users: [], scale: f, talkAnims: new Set() });
                const e = models.get(key), label = NPC_NAMES[m + '/' + i] || 'NPC ' + m + '/' + i;
                e.users.push({ map: m, room, index: i, name: label, kind: rom[a + 4] });
                e.talkAnims.add(u16(a + 0x18));
            }
        }
        for (const e of models.values()) {
            e.name = [...new Set(e.users.map(u => u.name))].join(' / ');
            e.firstMap = e.users[0].map;
            e.base = e.blob ? 0x20E6F0 : e.shannon ? 0x2A0000 : 0x20C0D0;
            e.size = e.blob ? e.blob[1] - e.blob[0] : e.shannon ? 0x7BC0 : 0x2620;
        }
        return [...models.values()];
    }

    /** sMapData, 0x44: map table ROM 0x577B0. The last word is the room count (equal to the rooms the doors and tables use). */
    function mapHeader(rom, m) {
        const o = 0x577B0 + m * 0x44, u32 = a => (rom[a] << 24 | rom[a + 1] << 16 | rom[a + 2] << 8 | rom[a + 3]) >>> 0;
        return {
            map: m, flags: rom[o] << 8 | rom[o + 1], romStart: u32(o + 4), romEnd: u32(o + 8), ram: u32(o + 0xC), geometry: u32(o + 0x10), modelSets: u32(o + 0x14),
            submaps: u32(o + 0x18), lights: u32(o + 0x1C), propGfx: u32(o + 0x20), regionBlock: u32(o + 0x3C), rooms: u32(o + 0x40),
        };
    }

    /** RAM as LoadMap leaves it for this map, plus the main segment and segment 1, which are always there. */
    function mapMemory(rom, h) {
        const mem = new Mem(), u32 = a => (rom[a] << 24 | rom[a + 1] << 16 | rom[a + 2] << 8 | rom[a + 3]) >>> 0;
        const put = (phys, s, e, name) => mem.map(phys, rom.subarray(s, e), name);
        put(0x400, 0x1000, 0x71920, 'main');
        put(0x95AF0, 0x71920, 0x753F0, 'segment1');
        mem.seg[1] = 0x95AF0;
        put(0x100000, 0x753F0, 0x851F0, 'gameplay common');
        put(0x810B0, 0xD86170, 0xD86570, 'faded sky palette');     // a run-time faded copy; a capture is within rounding of the original
        put(0x814B0, 0xD86170, 0xD86770, 'sky palettes');
        put(0x81AB0, 0xD86770, 0xD86970, 'rotating palette');
        if (h.flags & 2) put(0x10FE00, 0x851F0, 0xC8DE0, 'interiors common');
        if (h.flags & 7) {
            const b = 0x58140 + h.regionBlock * 12;
            put(u32(b + 8) & 0x1FFFFFFF, u32(b), u32(b + 4), 'region block');
        }
        put(h.ram & 0x1FFFFFFF, h.romStart, h.romEnd, 'map file');
        if ([3, 5, 7, 12].includes(h.map)) put(0x1E0000, 0x3E1090, 0x3F1BA0, 'field shared');
        return mem;
    }

    /** gDayPalettePeriods (ROM 0x4EAD0): 4 of time, palette, fade steps. The sky's palette is the last period begun at this time of day, as ResetTimeOfDay picks it. */
    function dayPalette(rom, time) {
        const word = o => (rom[o] << 24 | rom[o + 1] << 16 | rom[o + 2] << 8 | rom[o + 3]) >>> 0;
        let pal = word(0x4EAD0 + 3 * 12 + 4);
        for (let i = 0; i < 4; i++) if (time >= word(0x4EAD0 + i * 12)) pal = word(0x4EAD0 + i * 12 + 4);
        return pal;
    }

    /** DrawSky: the sky record's list, around the camera, under white (gSkyColour is white unless a light animation runs). */
    function compileSky(mem, rsp, rom, record) {
        const o = 0x61848 + record * 8 + 4, dl = (rom[o] << 24 | rom[o + 1] << 16 | rom[o + 2] << 8 | rom[o + 3]) >>> 0;
        rsp.reset();
        rsp.setState(ROOM_STATES.plain);
        rsp.env = [255, 255, 255, 255];
        rsp.run(dl);
    }

    /** The sky record a room's light record names: the palettes at 0x800808B0 (and their copy at 0x800806B0), the texture at 0x8007C6B0. */
    function mapSky(mem, rom, record, time = 13500) {
        const o = 0x61848 + record * 8, start = (rom[o] << 24 | rom[o + 1] << 16 | rom[o + 2] << 8 | rom[o + 3]) >>> 0;
        const pal = dayPalette(rom, time);
        mem.map(0x808B0, rom.subarray(start, start + 0x800), 'sky record palettes');
        mem.map(0x806B0, rom.subarray(start + pal * 0x200, start + (pal + 1) * 0x200), 'sky record palette copy');
        mem.map(0x7C6B0, rom.subarray(start + 0x800, start + 0x4800), 'sky record texture');
    }

    function edgeCrossesRight(x, z, ax, az, bx, bz) {
        if ((az <= z && z < bz) || (bz <= z && z < az)) {
            if (ax <= x && bx < x) return 1;
            if (x <= ax && x < bx) return 0;
            if (az !== bz && (z - az) * ((ax - bx) / (az - bz)) + ax < x) return 1;
        }
        return 0;
    }

    /** PollModelFaces: the height over (x, z) in the model's own space, or null. undefined y = hit a face with no height. */
    function pollFaces(mem, g, x, z, scale, mask) {
        const faces = mem.u32(g + 0x14), verts = mem.u32(g + 0x1C);
        if (!faces) return null;
        if (x < mem.s16(g) * scale || mem.s16(g + 2) * scale < x || z < mem.s16(g + 8) * scale || mem.s16(g + 0xA) * scale < z) return null;
        for (let i = 0, n = mem.u16(g + 0x18); i < n; i++) {
            const f = faces + i * 0x14;
            if (!(mem.u16(f + 6) & mask)) continue;
            const va = verts + mem.s16(f) * 8, vb = verts + mem.s16(f + 2) * 8, vc = verts + mem.s16(f + 4) * 8;
            const ax = mem.s16(va) * scale, az = mem.s16(va + 4) * scale, bx = mem.s16(vb) * scale, bz = mem.s16(vb + 4) * scale, cx = mem.s16(vc) * scale, cz = mem.s16(vc + 4) * scale;
            const on = (x === ax && z === az) || (x === bx && z === bz) || (x === cx && z === cz);
            if (!on && edgeCrossesRight(x, z, ax, az, bx, bz) + edgeCrossesRight(x, z, bx, bz, cx, cz) + edgeCrossesRight(x, z, ax, az, cx, cz) !== 1) continue;
            const nx = mem.f32(f + 8), ny = mem.f32(f + 0xC), nz = mem.f32(f + 0x10);
            if (ny === 0) return { y: undefined };
            return { y: -(nx * x + nz * z - (nx * ax + ny * mem.s16(va + 2) * scale + nz * az)) / ny };
        }
        return null;
    }

    /** A placed model's list number as SortMapModels reads it. */
    const modelKind = flags => (flags & 0x2000) ? 0 : flags & 0xFF;

    /** PollWorldCollision + PollModelInstance, for the floor only (flags 0xA00: no push out of walls). */
    function pollFloor(mem, room, startY, sx, sz) {
        const tryOne = id => {
            const t = room.transforms[id];
            if ((t.flags & 0xFF) >= 0x10) return null;
            let x = sx - t.x, z = sz - t.z;
            const a = 0.017453292519943295 * t.angle;
            if (a !== 0) {
                const sa = Math.sin(a), ca = Math.cos(a), nx = z * sa - x * ca, ny = z * ca + x * sa;
                x = -nx; z = ny;
            }
            const hit = pollFaces(mem, room.geometry + t.index * 0x20, x, z, t.scale, 0xA00);
            if (!hit) return null;
            return (hit.y === undefined ? startY : hit.y) + t.y;
        };
        let list = room.wallDefs, inside = true;
        if (room.tiled) {
            const tx = Math.trunc((sx - room.minX) / room.tileW), tz = Math.trunc((sz - room.minZ) / room.tileD);
            inside = tx >= 0 && tx < room.cols && tz >= 0 && tz < room.rows;
            if (inside) list = room.wallDefs + mem.u16(room.tileOffsets + (room.cols * tz + tx) * 2) * 2;
        }
        if (inside) {
            for (let i = 0, n = mem.u16(list); i < n; i++) {
                const y = tryOne(mem.u16(list + 2 + i * 2));
                if (y !== null) return y;
            }
        }
        for (let i = 0; i < room.modelCount; i++) {
            const y = tryOne(mem.u16(room.nonTiled + i * 2));
            if (y !== null) return y;
        }
        return startY;
    }

    const ITEM_NAMES = ['Spirit Light', 'Fresh Bread', 'Honey Bread', 'Healing Potion', "Dragon's Potion", 'Dew Drop', 'Mint Leaves', "Hero's Drink", 'Silent Flute',
        "Celine's Bell", 'Replica', "Giant's Shoes", 'Silver Amulet', 'Golden Amulet', 'White Wings', 'Yellow Wings', 'Blue Wings', 'Green Wings', 'Red Wings', 'Black Wings',
        'Earth Orb', 'Wind Jade', 'Water Jewel', 'Fire Ruby', 'Eletale Book', 'Dark Gaol Key'];   // labels only, by item ID

    /** A submap and its placed models, as LoadMap leaves them: models flagged 0x8000 stand on the floor. */
    function readRoom(mem, h, index) {
        const sub = h.submaps + index * 0x18, modelSet = mem.u16(sub), set = h.modelSets + modelSet * 0x2C;
        const room = {
            index, modelSet, light: mem.u16(sub + 2), geometry: h.geometry, area: mem.u16(sub + 0x12), flags: mem.u16(sub + 0x14), headerAddr: sub, setAddr: set,
            doorsAddr: mem.u32(sub + 4), doorCount: mem.s32(sub + 8), entrancesAddr: mem.u32(sub + 0xC), entranceCount: mem.u16(sub + 0x10),
            transformCount: mem.u16(set), modelCount: mem.u16(set + 2), cols: mem.s16(set + 4), rows: mem.s16(set + 6),
            minX: mem.f32(set + 8), minZ: mem.f32(set + 0xC), tileW: mem.f32(set + 0x10), tileD: mem.f32(set + 0x14),
            transformsAddr: mem.u32(set + 0x18), tileOffsets: mem.u32(set + 0x1C), wallDefs: mem.u32(set + 0x20), nonTiled: mem.u32(set + 0x24), tiled: mem.u16(set + 0x28) !== 0,
            transforms: [], doors: [], entrances: [],
        };
        for (let i = 0; i < room.transformCount; i++) {
            const a = room.transformsAddr + i * 0x18;
            room.transforms.push({ i, x: mem.f32(a), y: mem.f32(a + 4), z: mem.f32(a + 8), angle: mem.f32(a + 0xC), scale: mem.f32(a + 0x10), index: mem.s16(a + 0x14), flags: mem.u16(a + 0x16) });
        }
        // Every model a list reaches: the game draws those near the camera, we draw them all.
        const ids = new Set();
        const take = addr => { for (let i = 0, n = mem.u16(addr); i < n; i++) ids.add(mem.u16(addr + 2 + i * 2)); };
        if (room.tiled) { for (let t = 0; t < room.cols * room.rows; t++) take(room.wallDefs + mem.u16(room.tileOffsets + t * 2) * 2); }
        else if (room.wallDefs) take(room.wallDefs);
        for (let i = 0; i < room.modelCount; i++) ids.add(mem.u16(room.nonTiled + i * 2));
        room.instances = [...ids].sort((a, b) => a - b);
        for (const t of room.transforms) if (t.flags & 0x8000) t.y = pollFloor(mem, room, t.y, t.x, t.z);
        if (room.doorsAddr) for (let i = 0; i < room.doorCount; i++) {
            const a = room.doorsAddr + i * 0x24;
            room.doors.push({ i, x: mem.f32(a), z: mem.f32(a + 4), angle: mem.f32(a + 8), flags: mem.u16(a + 0x14), keyItem: mem.u16(a + 0x16), model: mem.u16(a + 0x1A), destMap: mem.u16(a + 0x1E), destRoom: mem.u16(a + 0x20), destEntrance: mem.u16(a + 0x22) });
        }
        if (room.entrancesAddr) for (let i = 0; i < room.entranceCount; i++) {
            const a = room.entrancesAddr + i * 0x14;
            room.entrances.push({ i, x: mem.f32(a), z: mem.f32(a + 4), yrot: mem.f32(a + 8), door: mem.u16(a + 0xE) });
        }
        return room;
    }

    /**
     * A room's lights, from its light record: +0 keys (LightKey, 0x3C: time, ambient + 3 colours, fog), +4 count, +8 direction set,
     * +0xC.. direction, +0x18 flags, +0x1C sky record. Midday when the record has several keys. The sun's angle at midday leaves
     * (0, 90, 50) (UpdateLightDirections). The other two lights turn with the game's camera, so a viewer default.
     */
    function roomLights(mem, h, room) {
        const r = h.lights + room.light * 0x20, keys = mem.u32(r), count = mem.u32(r + 4), flags = mem.u16(r + 0x18);
        const colours = k => [0, 1, 2, 3].map(c => [0, 1, 2].map(i => mem.s32(k + 4 + c * 12 + i * 4)));
        const range = k => [mem.s32(k + 0x34), mem.s32(k + 0x38)];
        let col, fog = range(keys);
        if (count <= 1) col = colours(keys);
        else {
            const time = mem.s32(keys + (count - 1) * 0x3C) / 2;
            let n = 1;
            while (n < count - 1 && time >= mem.s32(keys + n * 0x3C)) n++;
            const a = keys + (n - 1) * 0x3C, b = keys + n * 0x3C, ta = mem.s32(a), span = mem.s32(b) - ta, into = time - ta;
            const ca = colours(a), cb = colours(b);
            col = ca.map((c, i) => c.map((v, j) => (v * (span - into) + cb[i][j] * into) / span));
            const ra = range(a), rb = range(b);
            fog = ra.map((v, j) => (v * (span - into) + rb[j] * into) / span);
        }
        let sun = [-89, 89, 20];
        if (flags & 1) sun = [0, 90, 50];
        else if (mem.s32(r + 8)) sun = [mem.s32(r + 0xC), mem.s32(r + 0x10), mem.s32(r + 0x14)];
        const fill = [12, 90, 89];
        return {
            ambient: col[0], dirs: [{ col: col[2], dir: fill }, { col: col[1], dir: sun }, { col: col[2], dir: fill }], skyRecord: mem.s32(r + 0x1C),
            fog: { colour: col[3], near: fog[0], far: fog[1] }, skyOn: !!(flags & 4),
        };
    }

    /** StepLightAnim's mode 2, the brightened lights Brian, NPCs and enemies draw under: each colour c - (c >> 2) + 0x3F. A frame's map 165 is Brian's 187. */
    function actorLights(L) {
        const up = c => c.map(v => { const n = Math.trunc(v); return n - (n >> 2) + 0x3F; });
        return { ambient: up(L.ambient), dirs: L.dirs.map(d => ({ col: up(d.col), dir: d.dir })) };
    }

    /**
     * Who stands in a room, as SpawnNPCs and LoadMapBoss place them: an NPC where its record says, on the floor under it; a boss from the placement table.
     * Maps what they need into mem. Monsters are not here: random encounters place them, not the map.
     */
    function roomActors(rom, mem, h, room) {
        const actors = [], o = 0x577B0 + h.map * 0x44, u32 = a => (rom[a] << 24 | rom[a + 1] << 16 | rom[a + 2] << 8 | rom[a + 3]) >>> 0, listAddr = u32(o + 0x38);
        mem.map(0x206000, rom.subarray(0x869620, 0x86F6F0), 'brian');
        mem.map(0x20C0D0, rom.subarray(0x86F6F0, 0x871D10), 'held objects');
        mem.map(0x2A0000, rom.subarray(0xA70350, 0xA77F10), 'shannon');
        const blob = [u32(0x57480 + room.area * 8), u32(0x57484 + room.area * 8)];
        mem.map(0x20E6F0, rom.subarray(blob[0], blob[1]), 'npc blob');
        // SetupNPCs loads no NPCs for a room flagged 1.
        if (listAddr && !(room.flags & 1)) {
            const count = mem.u16(listAddr), list = mem.u32(listAddr + 4);
            for (let i = 0; i < count; i++) {
                const a = list + i * 0x2C;
                if (mem.u16(a) !== room.index) continue;
                const x = mem.f32(a + 0x1C), z = mem.f32(a + 0x20);
                actors.push({ kind: 'npc', index: i, name: NPC_NAMES[h.map + '/' + i] || 'NPC ' + i, addr: mem.u32(a + 0x10), x, y: pollFloor(mem, room, 0, x, z), z, yrot: mem.f32(a + 0x24), scale: mem.f32(a + 0x28), flags: 0 });
            }
        }
        mem.map(BOSSES.bankRam, rom.subarray(BOSSES.bankRom, BOSSES.bankEnd), 'cutscene bank');
        for (let n = 0; n < 8; n++) {
            const p = BOSSES.placements + n * 0x18;
            if (mem.u16(p) !== h.map || mem.u16(p + 2) !== room.index) continue;
            const s = mem.u32(BOSSES.files + n * 8), e = mem.u32(BOSSES.files + n * 8 + 4);
            mem.map(BOSSES.fileRam, rom.subarray(s, e), 'boss file');
            const x = mem.f32(p + 0xC), z = mem.f32(p + 0x10), rec = BOSSES.base + n * 0x38;
            actors.push({ kind: 'boss', index: n, name: BOSSES.names[n], addr: mem.u32(p + 8), x, y: pollFloor(mem, room, 0, x, z), z, yrot: mem.f32(p + 0x14), scale: mem.f32(rec + 0x20), flags: 1 });
        }
        return actors;
    }

    /** Pose everyone at this tick into rsp.batches: their idle, each from its own frame count. */
    function compileActors(mem, rsp, actors, tick, state, only) {
        const lights = rsp.lights;
        rsp.reset();
        for (const A of actors) {
            if (only !== undefined && only !== A) continue;
            if (!A.model) { const entry = readAnimEntry(mem, A.addr); A.model = { entry, parts: readParts(mem, entry) }; }
            rsp.setState(state);
            rsp.lights = lights;
            const M = buildActorMatrix(0, A.yrot, 0, A.scale, A.x, A.y, A.z), frame = tick % A.model.entry.frames;
            for (const p of posePart(mem, A.model, M, frame, tick, A.flags)) { rsp.mtx = p.mtx; if (p.dl) rsp.run(p.dl); }
        }
    }

    // The state the game has set when it reaches each group of a room's models, from a real frame.
    const ROOM_STATES = {
        plain: { geom: 0x2004, omH: 0x182C00, omL: 0x0F0A4000, combine: [0x12FE25, 0xFFFFF3F9], prim: [255, 255, 255, 255], env: [0, 0, 0, 180], tex: { on: 1, tile: 0, ss: 0x8000, st: 0x8000 } },
        lit: { geom: 0x30205, omH: 0x182C00, omL: 0xC8112038, combine: [0x127EC5, 0xFFFFF238], prim: [255, 255, 255, 255], env: [0, 0, 0, 180], tex: { on: 1, tile: 0, ss: 0x8000, st: 0x8000 } },
        prop: { geom: 0x30205, omH: 0x18AC00, omL: 0xC8113078, combine: [0x127FFF, 0xFFFFF238], prim: [255, 255, 255, 255], env: [0, 0, 0, 180], tex: { on: 1, tile: 0, ss: 0x8000, st: 0x8000 } },
        // DrawMapBillboards: G_RM_PASS with G_RM_AA_ZB_XLU_SURF2; the scrolling props G_RM_FOG_SHADE_A with it and their own combine.
        billboard: { geom: 0x32205, omH: 0x182C00, omL: 0x0C1849D8, combine: [0x327EC5, 0xFFFFFA38], prim: [255, 255, 255, 255], env: [0, 0, 0, 255], tex: { on: 1, tile: 0, ss: 0x8000, st: 0x8000 } },
        scrolling: { geom: 0x32205, omH: 0x182C00, omL: 0xC81049D8, combine: [0x121A04, 0xFFFFFFF8], prim: [255, 255, 255, 255], env: [0, 0, 0, 255], tex: { on: 1, tile: 0, ss: 0x8000, st: 0x8000 } },
    };
    // DrawMapBillboards' scrolling props, by kind - 0x40: the texture (RGBA16, 32 wide) and its height.
    const SCROLL_TEXTURES = [0x801093B0, 0x8010A3B0, 0x80129D10, 0x80160B30, 0x8014DA40], SCROLL_HEIGHTS = [0x40, 0x40, 0x20, 0x40, 0x20];

    const placedMatrix = t => buildActorMatrix(0, t.angle * 0.017453292519943295, 0, t.scale, t.x, t.y, t.z);    // guPosition(0, angle, 0, ...): the same matrix

    /** Models the viewer draws, in the game's order, into rsp.batches. Returns what it found and what it left out. */
    function compileRoom(mem, rsp, h, room, alpha, only) {
        const groups = { plain: [], lit: [], billboard: [], scrolling: [], props: [], flames: [], other: {} };
        for (const id of room.instances) {
            if (only !== undefined && only !== id) continue;
            const t = room.transforms[id], k = modelKind(t.flags);
            if (k === 0 || k === 8) ((t.flags & 0x4000) ? groups.lit : groups.plain).push(t);
            else if (k < 4 || k === 0x7F || k === 0x80) groups.billboard.push(t);
            else if (k >= 0x40 && k < 0x46) groups.scrolling.push(t);
            else if (k === 0x10) groups.props.push(t);
            else groups.other[k.toString(16)] = (groups.other[k.toString(16)] || 0) + 1;
        }
        const lights = rsp.lights;
        const dl = t => mem.u32(h.geometry + t.index * 0x20 + 0x10);
        const draw = t => { const d = dl(t); if (d) { rsp.mtx = placedMatrix(t); rsp.run(d); } };
        rsp.reset();
        rsp.setState(ROOM_STATES.plain); rsp.lights = lights;
        groups.plain.forEach(draw);
        rsp.setState(ROOM_STATES.lit); rsp.lights = lights;
        groups.lit.forEach(draw);
        const opaque = rsp.batches.length;
        rsp.batch = null;
        rsp.setState(ROOM_STATES.billboard); rsp.env = [0, 0, 0, alpha]; rsp.lights = lights;
        groups.billboard.forEach(draw);
        for (const t of groups.scrolling) {
            rsp.setState(ROOM_STATES.scrolling); rsp.env = [0, 0, 0, alpha]; rsp.lights = lights;
            const kind = (t.flags & 0xFF) - 0x40;
            rsp.loadScrollTexture(SCROLL_TEXTURES[kind], SCROLL_HEIGHTS[kind]);
            draw(t);
        }
        return { opaque, groups, triCount: rsp.triCount };
    }

    /** DrawMapProps: each prop faces the camera's yaw. Props share the transform layout; index is the prop type. */
    function compileProps(mem, rsp, h, props, yaw) {
        const lights = rsp.lights, types = new Set(props.map(t => t.index));
        rsp.reset();
        for (const type of types) {
            const setup = mem.u32(h.propGfx + type * 8), model = mem.u32(h.propGfx + type * 8 + 4);
            rsp.setState(ROOM_STATES.prop); rsp.lights = lights;
            rsp.mtx = buildActorMatrix(0, 0, 0, 1, 0, 0, 0);
            if (setup) rsp.run(setup);
            for (const t of props) {
                if (t.index !== type) continue;
                rsp.mtx = buildActorMatrix(0, yaw, 0, t.scale, t.x, t.y, t.z);
                if (model) rsp.run(model);
            }
        }
    }

    // ---------------------------------------------------------------- reading a model (AnimEntry, ModelPart, ModelKeyFrame)

    /** AnimEntry, 0xC: s16 count, s16 frames, ModelPart* parts, Gfx** dlists. */
    function readAnimEntry(mem, addr) {
        return { addr, count: mem.s16(addr), frames: mem.s16(addr + 2), partsAddr: mem.u32(addr + 4), dlistsAddr: mem.u32(addr + 8) };
    }

    /** ModelPart, 0x20, and its ModelKeyFrame records, 0x34 each. */
    function readParts(mem, entry) {
        const parts = [];
        for (let i = 0; i < entry.count; i++) {
            const a = entry.partsAddr + i * 0x20;
            const part = {
                index: i,
                keysAddr: mem.u32(a), keyCount: mem.u16(a + 4), frames: mem.u16(a + 6),
                pivot: [mem.f32(a + 8), mem.f32(a + 0xC), mem.f32(a + 0x10)],
                parent: mem.s8(a + 0x14),       // parent part + 1; 0 = a root
                dlist: mem.s8(a + 0x15),        // -1 = none
                flags: mem.u8(a + 0x16),        // bit 0 = face the camera, bit 1 = record its position
                dlistFrames: mem.u32(a + 0x18), // per-frame display list indices, or 0
                dlistFrameCount: mem.u16(a + 0x1C),
                keys: [],
            };
            for (let k = 0; k < part.keyCount; k++) {
                const ka = part.keysAddr + k * 0x34, ch = new Float64Array(9);
                for (let c = 0; c < 9; c++) ch[c] = mem.f32(ka + c * 4);
                part.keys.push({
                    ch, tension: mem.f32(ka + 0x24), continuity: mem.f32(ka + 0x28), bias: mem.f32(ka + 0x2C),
                    linear: mem.u16(ka + 0x30), frame: mem.u16(ka + 0x32),
                });
            }
            parts.push(part);
        }
        return parts;
    }

    /**
     * A model's AnimEntry table has no length in the data: it runs while records look right and share the first one's
     * display list table. (Over all 67 monsters that second test never decides it: the next thing after a table never
     * looks like a record.) base and size bound the pointers: the block the model loads into.
     */
    function listAnims(mem, addr, base, size) {
        const out = [], inside = a => (mem.phys(a) >= base && mem.phys(a) < base + size);
        for (let i = 0; i < 64; i++) {
            const a = addr + i * 12;
            if (!mem.has(a, 12)) break;
            const e = readAnimEntry(mem, a);
            if (!(e.count > 0 && e.count < 64 && e.frames > 0 && inside(e.partsAddr) && inside(e.dlistsAddr))) break;
            if (out.length && e.dlistsAddr !== out[0].dlistsAddr) break;
            out.push(e);
        }
        return out;
    }

    // ---------------------------------------------------------------- SampleSpline, HermiteBasis (27600.c)

    /** key: x, y, z, then the channels at +0xC, +0x10, +0x14 (angles in degrees), then three scales. */
    function sampleSpline(part, frame, key) {
        const K = part.keys;
        if (part.keyCount === 1) { key.set(K[0].ch); return key; }
        let n = 1;
        while (n < K.length - 1 && K[n].frame < frame) n++;
        const prev = K[n - 1], next = K[n];
        const f = frame - prev.frame, span = next.frame - prev.frame;
        const t = f / span;
        if (next.linear !== 0) {
            for (let i = 0; i < 9; i++) key[i] = prev.ch[i] + t * (next.ch[i] - prev.ch[i]);
            return key;
        }
        const t2 = t * t, t3 = t * t2, p01 = t2 * 3 - t3 - t3, p11 = t3 - t2;
        const h1 = 1 - p01, h2 = p01, h3 = p11 - t2 + t, h4 = p11;
        const a = (1 - prev.tension) * (1 + prev.continuity) * (1 + prev.bias);
        const b = (1 - prev.tension) * (1 - prev.continuity) * (1 - prev.bias);
        const c = (1 - next.tension) * (1 - next.continuity) * (1 + next.bias);
        const d = (1 - next.tension) * (1 + next.continuity) * (1 - next.bias);
        const before = prev.frame !== 0 ? K[n - 2] : null;
        const after = next.frame !== part.frames ? K[n + 1] : null;
        const inScale = before ? span / (next.frame - before.frame) : 0;
        const outScale = after ? span / (after.frame - prev.frame) : 0;
        for (let i = 0; i < 9; i++) {
            const delta = next.ch[i] - prev.ch[i];
            const tanIn = before ? ((prev.ch[i] - before.ch[i]) * a + b * delta) * inScale : (a + b) * 0.5 * delta;
            const tanOut = after ? ((after.ch[i] - next.ch[i]) * d + c * delta) * outScale : (c + d) * 0.5 * delta;
            key[i] = prev.ch[i] * h1 + next.ch[i] * h2 + tanIn * h3 + tanOut * h4;
        }
        return key;
    }

    // ---------------------------------------------------------------- matrices (27A90.c, 20DA0.c); mf[r][c] = m[r * 4 + c]

    /** BuildSRTMatrix takes degrees, BuildActorMatrix (the same layout, one scale) radians. */
    function srt(rx, ry, rz, x, y, z, sx, sy, sz) {
        const sinx = Math.sin(rx), cosx = Math.cos(rx), siny = Math.sin(ry), cosy = Math.cos(ry), sinz = Math.sin(rz), cosz = Math.cos(rz);
        const m = new Float64Array(16);
        m[0] = (cosz * cosy + sinz * sinx * siny) * sx;
        m[1] = sinz * cosx * sx;
        m[2] = (-siny * cosz + sinz * sinx * cosy) * sx;
        m[4] = (-sinz * cosy + cosz * sinx * siny) * sy;
        m[5] = cosz * cosx * sy;
        m[6] = (-sinz * -siny + cosz * sinx * cosy) * sy;
        m[8] = cosx * siny * sz;
        m[9] = -sinx * sz;
        m[10] = cosx * cosy * sz;
        m[12] = x; m[13] = y; m[14] = z; m[15] = 1;
        return m;
    }
    const DEG = 0.017453292;
    function buildActorMatrix(xrot, yrot, zrot, scale, x, y, z) { return srt(xrot, yrot, zrot, x, y, z, scale, scale, scale); }

    /** MatrixMultiply(a, b, out): with row vectors, v * out = v * b * a. */
    function mul(a, b) {
        const o = new Float64Array(16);
        for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) {
            o[r * 4 + c] = a[c] * b[r * 4] + a[4 + c] * b[r * 4 + 1] + a[8 + c] * b[r * 4 + 2] + (r === 3 ? a[12 + c] : 0);
        }
        o[15] = 1;
        return o;
    }

    /** ApplyPivotOffset: the part's vertices are stored in model space; this moves its pivot to the key's position. */
    function applyPivot(m, p) {
        for (let c = 0; c < 3; c++) m[12 + c] -= m[c] * p[0] + m[4 + c] * p[1] + m[8 + c] * p[2];
    }

    /**
     * DrawModel + DrawModelPart without the drawing: one row per part in the game's order, each with its full world
     * matrix and the display list it would call. A part with no list still poses its children (Brian's part 22 carries
     * the cape). flags: bit 0 = no root x / z (the "in place" of doorways), bit 1 = no root y.
     */
    function posePart(mem, model, actorMtx, frame, total, flags) {
        const { parts, entry } = model, out = [], key = new Float64Array(9);
        const visit = (parent, i) => {
            const part = parts[i], f = part.frames !== 0 ? frame % part.frames : 0;
            sampleSpline(part, f, key);
            let x = key[0], y = key[1], z = key[2];
            if (part.parent === 0) {
                if (flags & 1) x = z = 0;
                if (flags & 2) y = 0;
            }
            // The call's order, not the fields' order: key +0x10 is the X angle, key +0xC the Y angle.
            const local = srt(key[4] * DEG, key[3] * DEG, key[5] * DEG, x, y, z, key[6], key[7], key[8]);
            applyPivot(local, part.pivot);
            const m = mul(parent, local);
            let dl = 0;
            if (part.dlistFrames === 0) {
                if (part.dlist !== -1) dl = mem.u32(entry.dlistsAddr + part.dlist * 4);
            } else {
                dl = mem.u32(entry.dlistsAddr + mem.s32(part.dlistFrames + 4 * (total % part.dlistFrameCount)) * 4);
            }
            out.push({ index: i, parent: part.parent - 1, mtx: m, dl, billboard: !!(part.flags & 1) });
            for (let c = 0; c < parts.length; c++) if (parts[c].parent === i + 1) visit(m, c);
        };
        for (let i = 0; i < parts.length; i++) if (parts[i].parent === 0) visit(actorMtx, i);
        return out;
    }

    /**
     * One game tick of AdvanceAnimation (src/20DA0.c): the frame moves by the rate and wraps at the entry's length, the total
     * moves by 1 whatever the rate. The total is what per-frame display lists read (Brian's blink).
     * loop false is the viewer's: at the end it goes back to frame 0, total 0, and sets state.ended.
     */
    function advance(state, rate, length, loop = true) {
        let f = state.frame + rate;
        if (f >= length) {
            if (!loop) { state.ended = true; state.frame = 0; state.total = 0; return state; }
            f -= length;
        }
        state.frame = f;
        state.total += 1;
        return state;
    }

    // ---------------------------------------------------------------- the N64 Mtx format

    /** guMtxF2L's layout back to floats: 16 integer halves, then 16 fraction halves. */
    function readMtx(mem, addr) {
        const m = new Float64Array(16);
        for (let i = 0; i < 16; i++) {
            const hi = mem.s16(addr + i * 2), lo = mem.u16(addr + 32 + i * 2);
            m[i] = (hi * 65536 + lo) / 65536;
        }
        return m;
    }

    // ---------------------------------------------------------------- RDP: tile descriptors, TMEM, texture decode

    const FMT_RGBA = 0, FMT_YUV = 1, FMT_CI = 2, FMT_IA = 3, FMT_I = 4;

    function fnv(a, h = 0x811C9DC5) {
        for (let i = 0; i < a.length; i++) { h ^= a[i]; h = Math.imul(h, 0x01000193); }
        return h >>> 0;
    }

    /** RGBA8 pixels from TMEM for one tile descriptor. pal: the palette's type from othermode (2 RGBA16, 3 IA16, 0 none). */
    function decodeTile(tmem, t, tlutType) {
        const tileW = Math.max(1, ((t.lrs - t.uls) >> 2) + 1), tileH = Math.max(1, ((t.lrt - t.ult) >> 2) + 1);
        const maskW = t.masks ? 1 << t.masks : 0, maskH = t.maskt ? 1 << t.maskt : 0;
        const w = Math.min(1024, Math.max(tileW, maskW)), h = Math.min(1024, Math.max(tileH, maskH));
        const px = new Uint8Array(w * h * 4), base = t.tmem * 8, stride = t.line * 8;
        const from16 = (hi, lo, type, o) => {
            if (type === 3) { px[o] = px[o + 1] = px[o + 2] = hi; px[o + 3] = lo; return; }
            const v = hi << 8 | lo;
            px[o] = (v >> 11 & 31) * 255 / 31; px[o + 1] = (v >> 6 & 31) * 255 / 31; px[o + 2] = (v >> 1 & 31) * 255 / 31; px[o + 3] = v & 1 ? 255 : 0;
        };
        for (let y = 0; y < h; y++) {
            const row = base + y * stride;
            for (let x = 0; x < w; x++) {
                const o = (y * w + x) * 4;
                if (t.siz === 2) {
                    const a = (row + x * 2) & 0xFFF, hi = tmem[a], lo = tmem[(a + 1) & 0xFFF];
                    if (t.fmt === FMT_IA) { px[o] = px[o + 1] = px[o + 2] = hi; px[o + 3] = lo; }
                    else from16(hi, lo, 2, o);
                } else if (t.siz === 3) {
                    const a = (row + x * 2) & 0x7FF;
                    px[o] = tmem[a]; px[o + 1] = tmem[a + 1]; px[o + 2] = tmem[a + 0x800]; px[o + 3] = tmem[a + 0x801];
                } else {
                    let v;
                    if (t.siz === 1) v = tmem[(row + x) & 0xFFF];
                    else { const b = tmem[(row + (x >> 1)) & 0xFFF]; v = x & 1 ? b & 15 : b >> 4; }
                    if (t.fmt === FMT_CI) {
                        const i = t.siz === 0 ? (t.pal << 4 | v) : v, a = (0x800 + i * 8) & 0xFFF;
                        from16(tmem[a], tmem[a + 1], tlutType === 3 ? 3 : 2, o);
                    } else if (t.fmt === FMT_IA) {
                        let I, A;
                        if (t.siz === 1) { I = (v >> 4) * 17; A = (v & 15) * 17; }
                        else { I = (v >> 1) * 255 / 7; A = v & 1 ? 255 : 0; }
                        px[o] = px[o + 1] = px[o + 2] = I; px[o + 3] = A;
                    } else {        // I, and anything unexpected reads as intensity
                        const I = t.siz === 1 ? v : v * 17;
                        px[o] = px[o + 1] = px[o + 2] = px[o + 3] = I;
                    }
                }
            }
        }
        return { w, h, tileW, tileH, px, hash: fnv(px) };
    }

    // ---------------------------------------------------------------- RSP + the RDP state a material needs

    const G_ZBUFFER = 1, G_CULL_FRONT = 0x1000, G_CULL_BACK = 0x2000, G_LIGHTING = 0x20000, G_TEXTURE_GEN = 0x40000;
    const shiftFactor = s => s === 0 ? 1 : s <= 10 ? 1 / (1 << s) : (1 << (16 - s));

    class Rsp {
        /**
         * opts.raster false = no triangles or textures, only state and hooks (the test's walk of a whole frame).
         * opts.onMtx(addr, params), opts.onDL(target, depth): hooks for the test.
         */
        constructor(mem, opts = {}) {
            this.mem = mem; this.opts = opts; this.raster = opts.raster !== false;
            this.tmem = new Uint8Array(4096);
            this.tmemSrc = new Map();       // TMEM address -> the RAM address it was loaded from
            this.palSrc = 0;
            this.vtx = [];
            for (let i = 0; i < 32; i++) this.vtx.push({ x: 0, y: 0, z: 0, r: 0, g: 0, b: 0, a: 0, s: 0, t: 0 });
            this.tiles = [];
            for (let i = 0; i < 8; i++) this.tiles.push({ fmt: 0, siz: 0, line: 0, tmem: 0, pal: 0, cms: 0, cmt: 0, masks: 0, maskt: 0, shifts: 0, shiftt: 0, uls: 0, ult: 0, lrs: 0, lrt: 0 });
            this.timg = { fmt: 0, siz: 0, width: 1, addr: 0 };
            this.mtx = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
            this.geom = 0; this.omH = 0; this.omL = 0;
            this.combine = [0, 0]; this.prim = [255, 255, 255, 255]; this.env = [255, 255, 255, 255];
            this.tex = { on: 0, tile: 0, ss: 0xFFFF, st: 0xFFFF };
            this.lights = opts.lights || null;
            this.lightSlots = []; this.numLights = -1;
            this.lookX = [1, 0, 0]; this.lookY = [0, 1, 0];      // texture gen's axes (gSPLookAtX / Y)
            this.useLighting = true;
            this.unknown = {};
            this.reset();
        }
        reset() {
            this.batches = []; this.batch = null; this.triCount = 0; this.texCache = new Map(); this.tmemGen = 0;
            this.captured = [];     // with this.capture on: every triangle with its vertices' model-space data and the tag they were loaded under
            this.stats = { texgen: 0, unresolved: 0 };
        }
        /** Everything the game leaves set before it draws Brian (the test reads this from a real frame). */
        setState(s) {
            if (s.geom !== undefined) this.geom = s.geom;
            if (s.omH !== undefined) this.omH = s.omH;
            if (s.omL !== undefined) this.omL = s.omL;
            if (s.combine) this.combine = s.combine.slice();
            if (s.prim) { this.prim = s.prim.slice(); this.primAddr = null; }
            if (s.env) this.env = s.env.slice();
            if (s.tex) this.tex = Object.assign({}, s.tex);
            if (s.lights) this.lights = s.lights;
            if (s.lookX) this.lookX = s.lookX.slice();
            if (s.lookY) this.lookY = s.lookY.slice();
        }
        snapshot() {
            return { geom: this.geom, omH: this.omH, omL: this.omL, combine: this.combine.slice(), prim: this.prim.slice(), env: this.env.slice(), tex: Object.assign({}, this.tex), lights: this.lights ? JSON.parse(JSON.stringify(this.lights)) : null, lookX: this.lookX.slice(), lookY: this.lookY.slice() };
        }

        run(addr, maxCmds = 2000000) {
            const m = this.mem, stack = [];
            let pc = addr >>> 0, n = 0;
            while (n++ < maxCmds) {
                const w0 = m.u32(pc), w1 = m.u32(pc + 4), c = w0 >>> 24;
                pc = (pc + 8) >>> 0;
                switch (c) {
                    case 0x06: {       // G_DL
                        if (this.opts.onDL) this.opts.onDL(w1, stack.length);
                        if (((w0 >>> 16) & 0xFF) === 0) { if (stack.length >= 18) throw new Error('Display list stack overflow.'); stack.push(pc); }
                        pc = w1;
                        break;
                    }
                    case 0xB8: if (!stack.length) return; pc = stack.pop(); break;
                    case 0x01: this.gMtx(w0, w1); break;
                    case 0x03: this.gMoveMem(w0, w1); break;
                    case 0x04: this.gVtx(w0, w1); break;
                    case 0xBF: this.tri((w1 >>> 16 & 0xFF) >> 1, (w1 >>> 8 & 0xFF) >> 1, (w1 & 0xFF) >> 1); break;
                    case 0xB1:
                        this.tri((w0 >>> 16 & 0xFF) >> 1, (w0 >>> 8 & 0xFF) >> 1, (w0 & 0xFF) >> 1);
                        this.tri((w1 >>> 16 & 0xFF) >> 1, (w1 >>> 8 & 0xFF) >> 1, (w1 & 0xFF) >> 1);
                        break;
                    case 0xB7: this.geom = (this.geom | w1) >>> 0; break;
                    case 0xB6: this.geom = (this.geom & ~w1) >>> 0; break;
                    case 0xBA: { const sh = w0 >>> 8 & 0xFF, len = w0 & 0xFF, mask = ((2 ** len - 1) * 2 ** sh) >>> 0; this.omH = ((this.omH & ~mask) | w1) >>> 0; break; }
                    case 0xB9: { const sh = w0 >>> 8 & 0xFF, len = w0 & 0xFF, mask = ((2 ** len - 1) * 2 ** sh) >>> 0; this.omL = ((this.omL & ~mask) | w1) >>> 0; break; }
                    case 0xEF: this.omH = w0 & 0xFFFFFF; this.omL = w1; break;
                    case 0xBB: this.tex = { on: w0 & 0xFF, tile: w0 >>> 8 & 7, ss: w1 >>> 16, st: w1 & 0xFFFF }; break;
                    case 0xBC: {       // G_MOVEWORD
                        const idx = w0 & 0xFF, off = w0 >>> 8 & 0xFFFF;
                        if (idx === 6) m.seg[(off >> 2) & 15] = w1 & 0xFFFFFF;
                        else if (idx === 2) { this.numLights = ((w1 & 0xFFF) >> 5) - 1; this.syncLights(); }     // G_MW_NUMLIGHT: 0x80000000 + (n + 1) * 32
                        break;
                    }
                    case 0xFD: this.timg = { fmt: w0 >>> 21 & 7, siz: w0 >>> 19 & 3, width: (w0 & 0xFFF) + 1, addr: w1 }; break;
                    case 0xF5: {
                        const t = this.tiles[w1 >>> 24 & 7];
                        t.fmt = w0 >>> 21 & 7; t.siz = w0 >>> 19 & 3; t.line = w0 >>> 9 & 0x1FF; t.tmem = w0 & 0x1FF;
                        t.pal = w1 >>> 20 & 15; t.cmt = w1 >>> 18 & 3; t.maskt = w1 >>> 14 & 15; t.shiftt = w1 >>> 10 & 15;
                        t.cms = w1 >>> 8 & 3; t.masks = w1 >>> 4 & 15; t.shifts = w1 & 15;
                        break;
                    }
                    case 0xF2: {
                        const t = this.tiles[w1 >>> 24 & 7];
                        t.uls = w0 >>> 12 & 0xFFF; t.ult = w0 & 0xFFF; t.lrs = w1 >>> 12 & 0xFFF; t.lrt = w1 & 0xFFF;
                        break;
                    }
                    case 0xF3: if (this.raster) this.loadBlock(w0, w1); break;
                    case 0xF4: if (this.raster) this.loadTile(w0, w1); break;
                    case 0xF0: if (this.raster) this.loadTlut(w0, w1); break;
                    case 0xFC: this.combine = [w0 & 0xFFFFFF, w1]; break;
                    case 0xFA: this.prim = [w1 >>> 24, w1 >>> 16 & 255, w1 >>> 8 & 255, w1 & 255]; this.primAddr = pc - 8; break;
                    case 0xFB: this.env = [w1 >>> 24, w1 >>> 16 & 255, w1 >>> 8 & 255, w1 & 255]; break;
                    case 0xBD: case 0xBE: case 0xB2: case 0xB3: case 0xB4: case 0xE6: case 0xE7: case 0xE8: case 0xE9:
                    case 0xE3: case 0xE2: case 0xF6: case 0xF7: case 0xF8: case 0xF9: case 0xFE: case 0xFF: case 0xED:
                    case 0xE4: case 0xE5: case 0xE1: case 0xEE: case 0xB0: case 0xC0: case 0x00:
                        break;          // syncs, fills, the frame buffer and the like: nothing a model viewer draws
                    default:
                        this.unknown[c.toString(16)] = (this.unknown[c.toString(16)] || 0) + 1;
                }
            }
            throw new Error('Display list ran too long at 0x' + pc.toString(16));
        }

        gMtx(w0, w1) {
            const params = w0 >>> 16 & 0xFF;
            if (this.opts.onMtx) this.opts.onMtx(w1, params, this);
            if (params & 1) return;           // G_MTX_PROJECTION: the viewer has its own camera
            if (!this.mem.has(w1, 64)) return;
            const m = readMtx(this.mem, w1);
            this.mtx = (params & 2) ? m : mul(this.mtx, m);
        }

        gMoveMem(w0, w1) {
            const idx = w0 >>> 16 & 0xFF, m = this.mem;
            if ((idx === 0x82 || idx === 0x84) && m.has(w1, 16)) {     // G_MV_LOOKATY, G_MV_LOOKATX
                const v = [m.s8(w1 + 8), m.s8(w1 + 9), m.s8(w1 + 10)], l = Math.hypot(v[0], v[1], v[2]) || 1;
                this[idx === 0x84 ? 'lookX' : 'lookY'] = v.map(c => c / l);
                return;
            }
            if (idx < 0x86 || idx > 0x94 || !m.has(w1, 16)) return;
            const i = (idx - 0x86) >> 1;
            this.lightSlots[i] = { col: [m.u8(w1), m.u8(w1 + 1), m.u8(w1 + 2)], dir: [m.s8(w1 + 8), m.s8(w1 + 9), m.s8(w1 + 10)] };
            this.syncLights();
        }

        /** F3D: lights 0 .. n - 1 are directional, slot n is the ambient colour. */
        syncLights() {
            const n = this.numLights, a = this.lightSlots[n];
            if (n < 0 || !a) return;
            this.lights = { ambient: a.col.slice(), dirs: this.lightSlots.slice(0, n).filter(Boolean) };
        }

        gVtx(w0, w1) {
            if (!this.raster) return;
            const n = w0 >>> 10 & 0x3F, v0 = (w0 >>> 16 & 0xFF) >> 1, m = this.mem, M = this.mtx;
            const lit = (this.geom & G_LIGHTING) !== 0, L = this.lights;
            const ss = this.tex.ss / 65536, st = this.tex.st / 65536;
            for (let i = 0; i < n; i++) {
                const a = w1 + i * 16, v = this.vtx[(v0 + i) & 31];
                const x = m.s16(a), y = m.s16(a + 2), z = m.s16(a + 4);
                if (this.capture) { v.raw = [x, y, z]; v.tag = this.captureTag; v.litAtLoad = lit; v.nrm = lit ? [m.s8(a + 12), m.s8(a + 13), m.s8(a + 14)] : null; v.col = lit ? null : [m.u8(a + 12), m.u8(a + 13), m.u8(a + 14), m.u8(a + 15)]; }
                v.x = x * M[0] + y * M[4] + z * M[8] + M[12];
                v.y = x * M[1] + y * M[5] + z * M[9] + M[13];
                v.z = x * M[2] + y * M[6] + z * M[10] + M[14];
                v.s = m.s16(a + 8) / 32 * ss; v.t = m.s16(a + 10) / 32 * st;
                v.a = m.u8(a + 15);
                if (lit) {
                    const nx = m.s8(a + 12), ny = m.s8(a + 13), nz = m.s8(a + 14);
                    let wx = nx * M[0] + ny * M[4] + nz * M[8], wy = nx * M[1] + ny * M[5] + nz * M[9], wz = nx * M[2] + ny * M[6] + nz * M[10];
                    const l = Math.hypot(wx, wy, wz) || 1;
                    wx /= l; wy /= l; wz /= l;
                    if (this.useLighting && L) {
                        let r = L.ambient[0], g = L.ambient[1], b = L.ambient[2];
                        for (const d of L.dirs) {
                            if (!d) continue;
                            const ll = Math.hypot(d.dir[0], d.dir[1], d.dir[2]) || 1;
                            const dot = (wx * d.dir[0] + wy * d.dir[1] + wz * d.dir[2]) / ll;
                            if (dot > 0) { r += d.col[0] * dot; g += d.col[1] * dot; b += d.col[2] * dot; }
                        }
                        v.r = Math.min(255, r); v.g = Math.min(255, g); v.b = Math.min(255, b);
                    } else { v.r = v.g = v.b = 255; }
                    if (this.geom & G_TEXTURE_GEN) {    // the normal against the camera's axes; gSPTexture(size << 6) = size texels (src/1B200.c)
                        this.stats.texgen++;
                        const X = this.lookX, Y = this.lookY;
                        v.s = ((wx * X[0] + wy * X[1] + wz * X[2]) * 0.5 + 0.5) * 1024 * ss;
                        v.t = ((wx * Y[0] + wy * Y[1] + wz * Y[2]) * 0.5 + 0.5) * 1024 * st;
                    }
                } else {
                    v.r = m.u8(a + 12); v.g = m.u8(a + 13); v.b = m.u8(a + 14);
                }
            }
        }

        /** DrawMapBillboards' gDPLoadTextureTile + gDPSetTileSize for a scrolling prop (at rest: the scroll at 0). */
        loadScrollTexture(addr, height) {
            this.timg = { fmt: 0, siz: 2, width: 32, addr };
            const set = (t, uls, ult, lrs, lrt) => Object.assign(t, { fmt: 0, siz: 2, line: 8, tmem: 0, pal: 0, cms: 0, cmt: 0, masks: 5, maskt: height === 32 ? 5 : 6, shifts: 0, shiftt: 0, uls, ult, lrs, lrt });
            set(this.tiles[7], 0, 0, 31 << 2, (height - 1) << 2);
            this.loadTile(0xF4000000, (7 * 2 ** 24 + ((31 << 2) << 12) + ((height - 1) << 2)) >>> 0);
            set(this.tiles[0], 0, 0, (32 << 2) - 4, (height << 2) - 4);
        }

        loadBlock(w0, w1) {
            const t = this.tiles[w1 >>> 24 & 7], lrs = w1 >>> 12 & 0xFFF, uls = w0 >>> 12 & 0xFFF, ult = w0 & 0xFFF;
            const siz = this.timg.siz, bytes = ((lrs - uls + 1) << siz) >> 1;
            const src = (this.timg.addr + ((ult * this.timg.width + uls) << siz >> 1)) >>> 0;
            this.copyToTmem(src, t.tmem * 8, bytes, siz);
            this.tmemSrc.set(t.tmem * 8, src);
            this.tmemGen++;
        }
        loadTile(w0, w1) {
            const t = this.tiles[w1 >>> 24 & 7], uls = w0 >>> 12 & 0xFFF, ult = w0 & 0xFFF, lrs = w1 >>> 12 & 0xFFF, lrt = w1 & 0xFFF;
            const siz = this.timg.siz, x0 = uls >> 2, y0 = ult >> 2, x1 = lrs >> 2, y1 = lrt >> 2;
            const rowBytes = ((x1 - x0 + 1) << siz) >> 1, stride = (this.timg.width << siz) >> 1;
            this.tmemSrc.set(t.tmem * 8, (this.timg.addr + y0 * stride + ((x0 << siz) >> 1)) >>> 0);
            for (let y = y0; y <= y1; y++) {
                const src = (this.timg.addr + y * stride + ((x0 << siz) >> 1)) >>> 0;
                this.copyToTmem(src, t.tmem * 8 + (y - y0) * t.line * 8, rowBytes, siz);
            }
            this.tmemGen++;
        }
        copyToTmem(src, dst, bytes, siz) {
            const m = this.mem;
            if (!m.has(src, bytes)) { this.stats.unresolved++; return; }
            const data = m.slice(src, bytes), T = this.tmem;
            if (siz === 3) {        // RGBA32: red and green in the low half of TMEM, blue and alpha in the high half
                for (let i = 0; i + 3 < bytes; i += 4) {
                    const a = (dst + (i >> 1)) & 0x7FF;
                    T[a] = data[i]; T[a + 1] = data[i + 1]; T[a + 0x800] = data[i + 2]; T[a + 0x801] = data[i + 3];
                }
            } else for (let i = 0; i < bytes; i++) T[(dst + i) & 0xFFF] = data[i];
        }
        /** Each palette entry takes one 8-byte TMEM word's first two bytes (the hardware repeats it across the four). */
        loadTlut(w0, w1) {
            const t = this.tiles[w1 >>> 24 & 7], count = ((w1 >>> 12 & 0xFFF) >> 2) + 1, m = this.mem;
            const src = (this.timg.addr >>> 0);
            this.palSrc = src;
            if (!m.has(src, count * 2)) { this.stats.unresolved++; return; }
            const data = m.slice(src, count * 2);
            for (let i = 0; i < count; i++) {
                const a = (t.tmem * 8 + i * 8) & 0xFFF;
                this.tmem[a] = data[i * 2]; this.tmem[a + 1] = data[i * 2 + 1];
            }
            this.tmemGen++;
        }

        texFor(tileIndex) {
            const t = this.tiles[tileIndex & 7], tlut = this.omH >>> 14 & 3;
            const k = this.tmemGen + ':' + [t.fmt, t.siz, t.line, t.tmem, t.pal, t.masks, t.maskt, t.uls, t.ult, t.lrs, t.lrt, tlut].join(',');
            let d = this.texCache.get(k);
            if (!d) { d = decodeTile(this.tmem, t, tlut); this.texCache.set(k, d); }
            return {
                data: d, cms: t.cms, cmt: t.cmt, masks: t.masks, maskt: t.maskt,
                src: this.tmemSrc.get(t.tmem * 8) || 0, palSrc: t.fmt === FMT_CI ? this.palSrc : 0, fmt: t.fmt, siz: t.siz,
                scaleS: shiftFactor(t.shifts), scaleT: shiftFactor(t.shiftt), uls: t.uls / 4, ult: t.ult / 4,
                key: d.hash + '/' + [d.w, d.h, t.cms, t.cmt, t.masks, t.maskt, t.shifts, t.shiftt, t.uls, t.ult, d.tileW, d.tileH].join(','),
            };
        }

        material() {
            const usesTex = this.tex.on !== 0, tile = this.tex.tile;
            const combine = decodeCombine(this.combine[0], this.combine[1]), two = (this.omH >>> 20 & 3) === 1;
            const wants = i => combine.uses(i, two);
            const tex0 = usesTex && wants(0) ? this.texFor(tile) : null;
            const tex1 = usesTex && wants(1) ? this.texFor(tile + 1) : null;
            const L = this.omL;
            const cvgSel = (L & 0x2000) !== 0, cvgXA = (L & 0x1000) !== 0, forceBl = (L & 0x4000) !== 0, alphaCmp = L & 3;
            // The blender's last cycle, (P * A + M * B): cycle 2 at bits 28 / 24 / 20 / 16 in two-cycle mode, cycle 1 at 30 / 26 / 22 / 18.
            const sh = two ? 16 : 18, P = L >>> (sh + 12) & 3, M = L >>> (sh + 4) & 3, Bb = L >>> sh & 3;
            const blendAlpha = forceBl && P === 0 && M === 1 && Bb === 0;      // IN * A + MEM * (1 - A); else the pixel simply replaces
            const key = [
                this.combine[0], this.combine[1], two ? 2 : 1, this.geom & (G_CULL_BACK | G_CULL_FRONT | G_ZBUFFER | 0x10000), this.omL, this.prim.join(), this.primAddr, this.env.join(),
                tex0 ? tex0.key : '-', tex1 ? tex1.key : '-', this.omH >>> 12 & 3,
            ].join('|');
            return {
                key, combine, two, tex0, tex1, prim: this.prim.slice(), primAddr: this.primAddr, env: this.env.slice(),
                fog: !!(this.geom & 0x10000) && (L >>> 30 & 3) === 3 && (L >>> 26 & 3) === 2,     // G_FOG, and the blender's first cycle mixing in the fog colour by shade alpha
                cullBack: !!(this.geom & G_CULL_BACK), cullFront: !!(this.geom & G_CULL_FRONT), zbuffer: !!(this.geom & G_ZBUFFER),
                zUpdate: !!(L & 0x20), zCompare: !!(L & 0x10), decal: (L >>> 10 & 3) === 3,
                // ALPHA_CVG_SEL without CVG_X_ALPHA ignores texture alpha; both cut out.
                cutout: (cvgSel && cvgXA) || alphaCmp === 1, blend: blendAlpha, filter: this.omH >>> 12 & 3, omL: L,
            };
        }

        tri(a, b, c) {
            if (this.mute) return;                      // mute: run a list for the state it leaves, but draw nothing of it
            this.triCount++;
            if (!this.raster) return;
            const mat = this.material();
            if (!this.batch || this.batch.material.key !== mat.key) {
                this.batch = { material: mat, data: [] };
                this.batches.push(this.batch);
            }
            const D = this.batch.data;
            if (this.capture) this.captured.push({ tag: this.captureTag, material: mat, verts: [a, b, c].map(i => Object.assign({}, this.vtx[i & 31])) });
            for (const i of [a, b, c]) {
                const v = this.vtx[i & 31];
                D.push(v.x, v.y, v.z, v.r / 255, v.g / 255, v.b / 255, v.a / 255, v.s, v.t);
            }
        }
    }

    // ---------------------------------------------------------------- the colour combiner

    const CC_A = ['COMBINED', 'T0', 'T1', 'PRIM', 'SHADE', 'ENV', 'ONE', 'NOISE'];
    const CC_B = ['COMBINED', 'T0', 'T1', 'PRIM', 'SHADE', 'ENV', 'CENTER', 'K4'];
    const CC_C = ['COMBINED', 'T0', 'T1', 'PRIM', 'SHADE', 'ENV', 'SCALE', 'COMBINED_A', 'T0_A', 'T1_A', 'PRIM_A', 'SHADE_A', 'ENV_A', 'LOD', 'PRIM_LOD', 'K5'];
    const CC_D = ['COMBINED', 'T0', 'T1', 'PRIM', 'SHADE', 'ENV', 'ONE', 'ZERO'];
    const AC_ABD = ['COMBINED', 'T0', 'T1', 'PRIM', 'SHADE', 'ENV', 'ONE', 'ZERO'];
    const AC_C = ['LOD', 'T0', 'T1', 'PRIM', 'SHADE', 'ENV', 'PRIM_LOD', 'ZERO'];
    const name = (list, i) => list[i] || 'ZERO';

    /** G_SETCOMBINE's two cycles, each (a - b) * c + d for colour and for alpha. */
    function decodeCombine(w0, w1) {
        const cyc = (a, b, c, d, Aa, Ab, Ac, Ad) => ({
            a: name(CC_A, a), b: name(CC_B, b), c: name(CC_C, c), d: name(CC_D, d),
            Aa: name(AC_ABD, Aa), Ab: name(AC_ABD, Ab), Ac: name(AC_C, Ac), Ad: name(AC_ABD, Ad),
        });
        const c0 = cyc(w0 >>> 20 & 15, w1 >>> 28 & 15, w0 >>> 15 & 31, w1 >>> 15 & 7, w0 >>> 12 & 7, w1 >>> 12 & 7, w0 >>> 9 & 7, w1 >>> 9 & 7);
        const c1 = cyc(w0 >>> 5 & 15, w1 >>> 24 & 15, w0 & 31, w1 >>> 6 & 7, w1 >>> 21 & 7, w1 >>> 3 & 7, w1 >>> 18 & 7, w1 & 7);
        return {
            c0, c1,
            uses(i, two) {
                const s = 'T' + i, list = two ? [c0, c1] : [c0];
                return list.some(q => [q.a, q.b, q.c, q.d, q.Aa, q.Ab, q.Ac, q.Ad].some(n => n === s || n === s + '_A'));
            },
        };
    }

    root.ModelCore = {
        JP_SHA1, normalizeRom, sha1, Mem, BATTLE_PLACES, BOSSES, WALKTHROUGH, monsterLocations,
        MAP_NAMES, MAP_STORY, NPC_NAMES, npcMemory, listNpcModels, mapHeader, mapMemory, mapSky, compileSky, dayPalette, readRoom, roomLights, compileRoom, compileProps, roomActors, compileActors, actorLights, modelKind, placedMatrix, ROOM_STATES, pollFloor, ITEM_NAMES, readAnimEntry, readParts, listAnims, sampleSpline, buildActorMatrix, mul, posePart, readMtx, advance,
        Rsp, decodeCombine, decodeTile,
    };
})(globalThis);
