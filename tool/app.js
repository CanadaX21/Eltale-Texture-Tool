// The viewer page: opens your ROM, loads a model and one animation at a time as the game does, plays it.
// Brian: mesh and tables at ROM 0x869620 -> RAM 0x80206000 (func_80003350); animation banks from gBrianAnimRom (ROM
// 0x56B98) -> RAM 0x80200000 (LoadBrianAnimation). Monsters: a set's whole file from gMonsterSets (ROM 0x56DA0) ->
// RAM 0x8020E6F0 (LoadMonsterSet). Bosses: one file per boss -> RAM 0x802A7BC0 (LoadMapBoss), their tables in the cutscene
// bank (model_core.js BOSSES). Segment 1 at ROM 0x71920 -> RAM 0x80095AF0 for all.
(function () {
    'use strict';
    const C = globalThis.ModelCore;
    const $ = id => document.getElementById(id);

    // What the game has set when it reaches Brian's first list, read from a real frame.
    // Light colours and directions are the field lighting of map 0 in that frame; a viewer default, not part of the model.
    const ACTOR_STATE = {
        geom: 0x30205, omH: 0x182C00, omL: 0xC8113078, combine: [0x127FFF, 0xFFFFF238], prim: [255, 255, 255, 255], env: [0, 0, 0, 180],
        tex: { on: 1, tile: 0, ss: 0x8000, st: 0x8000 },
        lights: {
            ambient: [187, 174, 202],
            dirs: [{ col: [180, 173, 177], dir: [12, 90, 89] }, { col: [162, 183, 202], dir: [86, 25, 50] }, { col: [180, 173, 177], dir: [12, 90, 89] }],
        },
    };

    // Brian's animations, from the SetAnimation calls in src/3F50.c; 4, 5, 6, 19, 20, 21 have no call there and stay numbers.
    const BRIAN_ANIM_NOTES = {
        0: 'field idle', 1: 'walk', 2: 'run', 3: 'cast', 7: 'hit', 8: 'damaged', 9: 'knocked down', 10: 'staff swing', 11: 'staff swing 2',
        12: 'sign: start', 13: 'sign: hold', 14: 'message closed', 15: 'stop', 16: 'battle won', 17: 'battle idle', 18: 'battle start',
        22: 'item / self: hold', 23: 'item / self: start', 24: 'item / self: end', 25: 'low-HP idle', 26: 'door', 27: 'sign (other)',
        28: 'pick up', 29: 'pick up: hold',
    };

    // The rate each animation plays at (SetAnimation's nextFramerate): every other Brian animation is 1.
    // Walk and run follow the stick, want * 14 + 3 (BrianState_Walk, BrianState_Run). Walk: 10, what BrianWalkThroughDoor sets.
    // Run: 31, the stick at full (want = 2).
    const BRIAN_RATES = { 1: { rate: 10, note: '3-24 by stick' }, 2: { rate: 31, note: 'up to 31 by stick' } };

    const MON_BASE = 0x8020E6F0, STATS_SIZE = 0x38, BRIAN_SCALE = 0.07;     // Brian's actor scale (read from RAM)
    // src/9D50.c: walk and hurt play at 10 in a normal battle, 1 in a boss battle (gBattleState 0x100). Attacks are 1.
    const MONSTER_FAST_RATE = 10;
    // Labels only, by model ID. The ROM's own names are Japanese.
    const MONSTER_NAMES = [
        ['Were Hare', 'Hell Hound', 'Man Eater', 'Big Mouth', 'Bumbershoot', 'Parassault', 'Ork Jr', 'Gremlin', 'Skeleton', 'Ghosthound', 'Merrow', 'Wolf Goat'],
        ['Goblin', 'Frog King', 'Apophis', 'Mad Doll', 'Death Hugger', 'Kobold', 'Man Trap', 'Bat', 'Frog Knight', 'Marionasty', 'Dark Goblin', 'Hot Lips', 'Ghost Stalker', 'Treant', 'Cockatrice'],
        ['Multieyes', 'Mimic', 'Crawler', 'Scorpion', 'Scarecrow', 'Wyvern', 'Skelebat', 'Cryshell', 'Bloodgel', 'Catapillar', 'Fishman'],
        ['Sandman', 'Were Cat', 'Nightmare', 'Blue Man', 'Winged Sunfish', 'Gloom Wing', 'Ogre', 'Rocky', 'Red Wyvern', 'Flamed Mane', 'Magma Fish', 'Rose Knight', 'White Knight'],
        ['Ork', 'Ghost', 'Will O Wisp', 'Sprite', 'Jack O Lantern', 'Arachnoid', 'Lamia', 'Temptress', 'Pixie', 'Grangach', 'Thunder Gel', 'Termant'],
        ['Judgment', 'Pale Rider', 'Pin Head', 'Spriggan'],
    ];

    let rom = null, mem = null, rsp = null, renderer = null;
    let source = 'brian', models = [], chosen = null, animList = [], current = null, model = null, labelFilter = '';
    let frame = 0, total = 0, playing = true, last = 0, carry = 0, speed = 1;
    let showSkeleton = false, inPlace = false, wantFrame = false;
    let loop = true, ended = false;     // ended: playing stopped because a play-once animation reached its end
    let testYaw = null, testVP = null, testActor = null, testBg = null, testLook = null, testLights = null;      // the test hook's game camera, actor, lights
    let testFrame = null;       // the test hook's whole game frame from a RAM dump: the batches, drawn as they are
    let showSky = true, showFog = false, lastView = null, testFog = null;
    let mapView = null, showDoors = true, showActors = true, exportNote = '', mainMem = null, mainRsp = null;
    let activeTab = 'props', selBone = -1, dlIso = null, dlTable = [], roomIso = null, transparent = false, bgColor = [0.075, 0.09, 0.11], gifBusy = false, animQuery = '';
    let seenTex = new Map(), selTex = null, modelSource = 'brian', lastOf = {};
    const TT = globalThis.TextureTool, work = new Workspace(), workReady = work.init();
    const mod = { files: [], tints: {}, result: null, importers: {}, edited: new Set(), stamps: '' };
    let origRom = null, texFolder = null, selRow = null, replaceFor = null;
    const keys = new Set();
    const cam = { yaw: 0.45, pitch: 0.12, dist: 330, target: [0, 74, 0] };

    function u32(o) { return (rom[o] << 24 | rom[o + 1] << 16 | rom[o + 2] << 8 | rom[o + 3]) >>> 0; }
    const hex = v => '0x' + (v >>> 0).toString(16).toUpperCase();

    function loadRom(bytes, name, keepOut) {
        const data = C.normalizeRom(bytes);
        const hash = C.sha1(data);
        if (hash !== C.JP_SHA1) {
            throw new Error('This is not the original Japanese ROM (its SHA-1 is ' + hash + '), so the addresses here would be wrong. Patched ROMs and Quest 64 are not supported yet.');
        }
        origRom = data;
        rom = data.slice();      // what the view reads: replaced textures are written into this, never into origRom
        mod.importers = {};
        mem = new C.Mem();
        mem.map(0x206000, rom.subarray(0x869620, 0x86F6F0), 'brian');
        mem.map(0x95AF0, rom.subarray(0x71920, 0x753F0), 'segment1');
        mem.seg[1] = 0x95AF0;
        mem.map(C.BOSSES.bankRam, rom.subarray(C.BOSSES.bankRom, C.BOSSES.bankEnd), 'cutscenebank');
        rsp = new C.Rsp(mem);
        mainMem = mem; mainRsp = rsp;
        rsp.setState(ACTOR_STATE);
        rsp.useLighting = $('tLight').classList.contains('on');
        $('romName').textContent = name;
        if (!keepOut) rememberRom(data, name);
        $('open').classList.add('hidden');
        buildModels();
        buildBosses();
        for (const n of C.listNpcModels(rom)) models.push(Object.assign(n, { kind: 'npc', places: [...new Set(n.users.map(u => C.MAP_NAMES[u.map]))], animsAddr: n.md }));
        buildMaps();
        lastOf = {}; modelSource = 'brian';
        chooseSource('brian');
        workReady.then(() => refreshEdits()).catch(e => console.error(e));
    }

    /** Every model the open ROM offers. A monster's data is reachable only once its set's file is mapped, so this reads the ROM. */
    function buildModels() {
        models = [{ kind: 'brian', name: 'Brian', places: [], maps: [], ram: 0x80206064 }];
        const where = C.monsterLocations(rom), placeName = m => C.BATTLE_PLACES[m] || 'map ' + m;
        MONSTER_NAMES.forEach((names, set) => {
            const row = 0x56DA0 + set * 20, start = u32(row), end = u32(row + 4), table = u32(row + 8), stats = u32(row + 12);
            const tableRom = table - MON_BASE + start;
            names.forEach((name, id) => {
                models.push({
                    kind: 'monster', name, id, set, start, end, stats, table, rec: stats + id * STATS_SIZE,
                    maps: where[set + '/' + id] || [],
                    places: C.WALKTHROUGH.flat().filter(mp => (where[set + '/' + id] || []).includes(mp)).map(placeName),
                    animsAddr: u32(tableRom + id * 4),
                });
            });
        });
    }

    function buildMaps() {
        for (const { maps } of C.MAP_STORY) {
            for (const n of maps) models.push({ kind: 'map', name: C.MAP_NAMES[n], map: n, rooms: C.mapHeader(rom, n).rooms, places: [] });
        }
    }

    /** Bosses come from the cutscene bank, which is mapped whatever is selected. */
    function buildBosses() {
        const B = C.BOSSES;
        B.names.forEach((name, n) => {
            const rec = B.base + n * STATS_SIZE, id = mem.s16(rec + 2);
            models.push({
                kind: 'boss', name, number: n, id, rec, start: mem.u32(B.files + n * 8), end: mem.u32(B.files + n * 8 + 4),
                animsAddr: mem.u32(B.tables + id * 4), places: [B.places[n]], map: mem.u16(B.placements + n * 0x18), room: mem.u16(B.placements + n * 0x18 + 2), maps: [],
            });
        });
    }

    function chooseSource(s) {
        source = s;
        document.body.classList.remove('tex-mode');
        $('modelFilter').value = '';
        labelFilter = '';
        buildModelList();
        selectModel(lastOf[s] || models.find(m => m.kind === s));      // each list comes back to what you last had open in it
    }

    function buildModelList() {
        const box = $('models'), q = labelFilter.trim().toLowerCase();
        box.textContent = '';
        if (source === 'tex') { buildFolderList(box, q); return; }
        const row = m => {
            const d = document.createElement('div');
            d.className = 'row' + (m === chosen ? ' sel' : '');
            const label = document.createElement('span');
            label.textContent = m.name;
            const addr = document.createElement('em');
            addr.textContent = m.kind === 'npc' ? C.MAP_NAMES[m.firstMap] : m.kind === 'map' ? m.rooms + (m.rooms === 1 ? ' room' : ' rooms') : m.kind === 'boss' ? m.places[0] : (m.kind === 'monster' ? m.animsAddr : m.ram).toString(16).toUpperCase();
            d.append(label, addr);
            d.onclick = () => selectModel(m);
            box.append(d);
        };
        if (source === 'npc') {     // by the area each is first met in, in story order
            C.MAP_STORY.forEach(({ area, maps }, i) => {
                const list = models.filter(m => m.kind === 'npc' && maps.includes(m.firstMap) && (!q || m.name.toLowerCase().includes(q) || m.places.join().toLowerCase().includes(q)));
                if (!list.length) return;
                const h = document.createElement('div');
                h.className = 'group';
                h.textContent = (i + 1) + '. ' + area;
                box.append(h);
                list.forEach(row);
            });
            return;
        }
        if (source === 'map') {     // one heading per area, in story order
            C.MAP_STORY.forEach(({ area, maps }, i) => {
                const list = maps.map(n => models.find(m => m.kind === 'map' && m.map === n)).filter(m => !q || m.name.toLowerCase().includes(q));
                if (!list.length) return;
                const h = document.createElement('div');
                h.className = 'group';
                h.textContent = (i + 1) + '. ' + area;
                box.append(h);
                list.forEach(row);
            });
            return;
        }
        if (source !== 'monster') {
            models.filter(m => m.kind === source && (!q || m.name.toLowerCase().includes(q) || m.places.join().toLowerCase().includes(q))).forEach(row);
            return;
        }
        // One heading per game area, in walkthrough order. A monster met in two areas is listed under both.
        C.WALKTHROUGH.forEach((maps, area) => {
            const areaName = maps.map(mp => C.BATTLE_PLACES[mp]).join(', ');
            const list = models.filter(m => m.kind === 'monster' && m.maps.some(mp => maps.includes(mp))
                && (!q || m.name.toLowerCase().includes(q) || maps.some(mp => m.maps.includes(mp) && C.BATTLE_PLACES[mp].toLowerCase().includes(q))));
            if (!list.length) return;
            const first = m => maps.findIndex(mp => m.maps.includes(mp));
            list.sort((a, b) => first(a) - first(b) || a.set - b.set || a.id - b.id);
            const h = document.createElement('div');
            h.className = 'group';
            h.textContent = (area + 1) + '. ' + areaName;
            box.append(h);
            list.forEach(row);
        });
    }

    /** As LoadMonsterSet: the set's whole file at 0x8020E6F0, its pointers already absolute. */
    function selectModel(m) {
        chosen = m;
        lastOf[m.kind] = m;
        exportNote = '';
        selBone = -1; dlIso = null; roomIso = null;
        const isMap = m.kind === 'map';
        for (const b of $('leftTabs').children) b.classList.toggle('on', b.dataset.side === (isMap ? 'maps' : 'models'));
        if (activeTab === 'tex' || activeTab === 'edits') setTab(activeTab);
        $('modelFilter').placeholder = isMap ? 'Filter maps' : 'Filter by name or place';
        if (!isMap) { modelSource = m.kind; $('source').value = m.kind; }
        animQuery = ''; $('animFilter').value = '';
        resetTextures();
        document.body.classList.toggle('map-mode', m.kind === 'map');
        $('listTitle').textContent = m.kind === 'map' ? 'Rooms' : 'Animations';
        if (m.kind === 'map' && activeTab === 'bones') setTab('props');
        if (m.kind === 'map') { selectMap(m); return; }
        mapView = null;
        $('labels').textContent = '';
        // An NPC needs its own RAM: its map, its area's blob. Everything else shares the main one.
        if (m.kind === 'npc') {
            mem = C.npcMemory(rom, m);
            rsp = new C.Rsp(mem);
        } else if (mem !== mainMem) { mem = mainMem; rsp = mainRsp; }
        rsp.useLighting = $('tLight').classList.contains('on');
        if (m.kind === 'npc') {
            // src/9D50.c: 0 idle, 1 walk, and the record's talk animation. Nothing is marked "not played": event overlays are outside the decomp's C.
            animList = C.listAnims(mem, m.md, m.base, m.size).map((e, i) => ({
                id: i, entryAddr: e.addr, count: e.count, frames: e.frames, rate: 1, rateNote: '',
                note: [i === 0 ? 'idle' : i === 1 ? 'walk' : '', i && m.talkAnims.has(i) ? 'talk' : ''].filter(Boolean).join(', '),
            }));
        } else if (m.kind === 'brian') {
            const table = u32(0x80055D40 - 0x7FFFF400);
            animList = [];
            for (let i = 0; i < 30; i++) {
                const start = u32(0x56B98 + i * 8), end = u32(0x56B98 + i * 8 + 4), a = table + i * 12;
                const r = BRIAN_RATES[i] || { rate: 1 };
                animList.push({ id: i, bankStart: start, bankEnd: end, entryAddr: a, count: mem.s16(a), frames: mem.s16(a + 2), note: BRIAN_ANIM_NOTES[i], rate: r.rate, rateNote: r.note });
            }
        } else {
            const isBoss = m.kind === 'boss', base = isBoss ? C.BOSSES.fileRam : MON_BASE & 0x1FFFFFFF;
            mem.map(base, rom.subarray(m.start, m.end), isBoss ? 'bossfile' : 'monsters');
            const rec = m.rec, hurt = mem.u16(rec + 0x28);
            m.scale = mem.f32(rec + 0x20);
            // src/9D50.c: 0 and 1 are set directly (idle, walk), hurt comes from the base record, and the rest from the
            // monster's AI options (base +0x2C count, +0x30 table of 0x18 B: +8 anim, +0xA next, +0xC recover).
            const roles = new Map([[0, 'idle'], [1, 'walk'], [hurt, 'hurt']]);
            for (let i = 0, n = mem.u16(rec + 0x2C), t = mem.u32(rec + 0x30); i < n; i++) {
                [[8, 'attack'], [0xA, 'attack: hold'], [0xC, 'attack: recover']].forEach(([o, role]) => {
                    const v = mem.s16(t + i * 0x18 + o);
                    if (v >= 0 && !roles.has(v)) roles.set(v, role);
                });
            }
            const all = C.listAnims(mem, m.animsAddr, base, m.end - m.start);
            const fastFrames = new Set([all[1] && all[1].frames, all[hurt] && all[hurt].frames]);
            animList = all.map((e, i) => {
                const role = roles.get(i);
                const fast = !isBoss && (role === 'walk' || role === 'hurt');     // a boss battle plays them at 1
                // Nothing plays these, so the game gives them no rate. Most are the length of walk or hurt: 10 is a guess from that.
                const guess = !isBoss && !role && fastFrames.has(e.frames);
                return {
                    id: i, entryAddr: e.addr, count: e.count, frames: e.frames, note: role || 'not played',
                    rate: fast || guess ? MONSTER_FAST_RATE : 1,
                    rateNote: fast ? '1 in boss battles' : guess ? 'assumed: not played' : '',
                };
            });
        }
        // DrawEnemies and DrawBoss call DrawModel(1, ...): the root's x and z stay still. Brian and NPCs walk on theirs (DrawModel(0, ...)).
        inPlace = m.kind === 'monster' || m.kind === 'boss';
        $('tInPlace').classList.toggle('on', inPlace);
        buildModelList();
        buildAnimList();
        selectAnim(m.lastAnim || 0);
        seedTextures();
        wantFrame = true;
    }

    // ---- maps
    function selectMap(m) {
        const h = C.mapHeader(rom, m.map);
        mapView = { h, mem: C.mapMemory(rom, h), m };
        model = null;
        buildModelList();
        const box = $('anims');
        box.textContent = '';
        $('animCount').textContent = '(' + h.rooms + ')';
        for (let r = 0; r < h.rooms; r++) {
            const d = document.createElement('div');
            d.textContent = 'Room ' + r;
            d.dataset.id = r;
            d.onclick = () => selectRoom(r);
            box.append(d);
        }
        filterAnimList();
        selectRoom(m.lastRoom || 0);
    }

    function compileRoom() {
        const V = mapView, r = V.rsp, alpha = rom[0x80060C88 - 0x7FFFF400 + V.m.map];
        r.useLighting = $('tLight').classList.contains('on');
        r.lights = testLights || V.lights;
        const look = testLook || viewAxes();
        r.lookX = look.slice(0, 3); r.lookY = look.slice(3, 6);
        const only = !roomIso ? undefined : roomIso.kind === 'model' ? roomIso.id : -1;
        V.out = C.compileRoom(V.mem, r, V.h, V.room, alpha, only);
        if (only === undefined) V.fullOut = V.out;
        V.batches = r.batches;
        renderer.upload(V.batches);
        V.propYaw = null;
        V.actorTick = -1;
    }

    function viewAxes() {
        const m = viewProj(1), x = unit([m[0], m[4], m[8]]), y = unit([m[1], m[5], m[9]]);
        return [...x, ...y];
    }

    function selectRoom(i) {
        chosen.lastRoom = i;
        const V = mapView;
        V.room = C.readRoom(V.mem, V.h, i);
        V.lights = C.roomLights(V.mem, V.h, V.room);
        C.mapSky(V.mem, rom, V.lights.skyRecord, +new URLSearchParams(location.search).get('skytime') || undefined);
        V.skyRsp = new C.Rsp(V.mem);
        C.compileSky(V.mem, V.skyRsp, rom, V.lights.skyRecord);
        V.rsp = new C.Rsp(V.mem);
        V.propRsp = new C.Rsp(V.mem);
        V.actorRsp = new C.Rsp(V.mem);
        V.actors = C.roomActors(rom, V.mem, V.h, V.room);
        V.tick = 0;
        roomIso = null;
        resetTextures();
        compileRoom();
        for (const d of $('anims').children) d.classList.toggle('sel', +d.dataset.id === i);
        // Doors and entrances have no height of their own: they stand on the floor under them.
        const floorY = (x, z) => C.pollFloor(V.mem, V.room, 0, x, z);
        const name = (m, r) => C.MAP_NAMES[m] + (C.mapHeader(rom, m).rooms > 1 ? ' room ' + r : '');
        const box = $('labels');
        box.textContent = '';
        V.labels = [];
        const add = (x, z, text, cls) => {
            const e = document.createElement('div');
            e.className = cls;
            e.textContent = text;
            box.append(e);
            V.labels.push({ x, y: floorY(x, z), z, e });
        };
        for (const d of V.room.doors) {
            const key = (d.flags & 0x10) ? ' (needs ' + (C.ITEM_NAMES[d.keyItem] || 'item ' + d.keyItem) + ')' : '';
            add(d.x, d.z, '→ ' + name(d.destMap, d.destRoom) + key, 'door');
        }
        for (const e of V.room.entrances) add(e.x, e.z, 'entrance ' + e.i + ' (door 0x' + e.door.toString(16).toUpperCase() + ')', 'door in');
        updateMapProps();
        refreshPanels();
        if (!testVP) { cam.yaw = 0.45; cam.pitch = 0.6; wantFrame = true; }
    }

    function updateMapProps() {
        const V = mapView, h = V.h, R = V.room, out = V.fullOut, p = $('props');
        p.textContent = '';
        const add = (k, v) => { const t = document.createElement('dt'); t.textContent = k; const d = document.createElement('dd'); d.textContent = v; p.append(t, d); };
        const left = out.groups.other;
        const flames = (left['11'] || 0) + (left['12'] || 0), spin = left['82'] || 0, emit = left['81'] || 0;
        add('Map', h.map + ' ' + C.MAP_NAMES[h.map]);
        add('Room', R.index);
        add('ROM block', hex(h.romStart) + '-' + hex(h.romEnd));
        add('RAM', hex(h.ram));
        add('Room header', hex(R.headerAddr));
        add('Model set', R.modelSet + ' at ' + hex(R.setAddr));
        add('Grid', R.cols + ' × ' + R.rows + (R.tiled ? ' at ' + hex(R.tileOffsets) : ' (untiled)'));
        add('Objects', R.instances.length);
        add('Actors', V.actors.length);
        add('Trees and props', out.groups.props.length);
        add('Billboards', out.groups.billboard.length);
        add('Scrolling', out.groups.scrolling.length);
        add('Doors', R.doors.length);
        add('Entrances', R.entrances.length);
        add('Monster set', R.area);
        if (flames) add('Not drawn: flames', flames);
        if (spin) add('Not drawn: spinning', spin);
        if (emit) add('Not drawn: emitters', emit);
    }

    function updateLabels(vp) {
        const V = mapView, box = $('labels'), W = box.clientWidth, H = box.clientHeight;
        box.style.display = showDoors && !roomIso && !document.body.classList.contains('bare') ? '' : 'none';
        if (!showDoors) return;
        for (const L of V.labels) {
            const x = L.x, y = L.y + 6, z = L.z;
            const cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
            if (cw <= 0) { L.e.style.display = 'none'; continue; }
            const sx = (vp[0] * x + vp[4] * y + vp[8] * z + vp[12]) / cw, sy = (vp[1] * x + vp[5] * y + vp[9] * z + vp[13]) / cw;
            L.e.style.display = sx < -1.05 || sx > 1.05 || sy < -1.05 || sy > 1.05 ? 'none' : '';
            L.e.style.left = ((sx + 1) / 2 * W).toFixed(1) + 'px';
            L.e.style.top = ((1 - sy) / 2 * H).toFixed(1) + 'px';
        }
    }

    function renderMap() {
        const V = mapView, aspect = renderer.resize();
        const yaw = testVP ? (testYaw || 0) : cam.yaw;
        const whole = Math.floor(V.tick);
        if (V.actorTick !== whole) {
            V.actorTick = whole;
            const A = V.actorRsp;
            A.useLighting = V.rsp.useLighting;
            A.lights = testLights || C.actorLights(V.lights);
            const look = testLook || viewAxes();
            A.lookX = look.slice(0, 3); A.lookY = look.slice(3, 6);
            if ((showActors || (roomIso && roomIso.actor)) && !(roomIso && roomIso.kind === 'model')) C.compileActors(V.mem, A, V.actors, whole, ACTOR_STATE, roomIso ? roomIso.actor : undefined);
            else A.reset();
        }
        if (V.propYaw !== yaw) {
            V.propRsp.useLighting = V.rsp.useLighting;
            V.propRsp.lights = V.rsp.lights;
            const look = testLook || viewAxes();
            V.propRsp.lookX = look.slice(0, 3); V.propRsp.lookY = look.slice(3, 6);
            C.compileProps(V.mem, V.propRsp, V.h, V.out.groups.props, yaw);
            V.propYaw = yaw;
        }
        if (wantFrame && !testVP) {     // only now: one actor or prop alone has to be posed before it can be framed
            frameBatches(V.batches.concat(V.propRsp.batches, roomIso ? V.actorRsp.batches : []));
            V.propYaw = null;
            wantFrame = false;
        }
        const vp = testVP || viewProj(aspect);
        const opaque = V.batches.slice(0, V.out.opaque), xlu = V.batches.slice(V.out.opaque);
        const clear = transparent && !testBg, skyShown = showSky && !clear && !roomIso;
        // The game's background: the fog colour on maps with flag 0x80, else black, and the sky in front of it if the light record has one.
        const fill = (V.h.flags & 0x80 ? V.lights.fog.colour : [0, 0, 0]).map(v => v / 255);
        renderer.begin(testBg || (skyShown ? fill : bgColor), clear ? 0 : 1);
        const fv = testFog || [V.lights.fog.near, V.lights.fog.far, ...V.lights.fog.colour];
        renderer.fog = showFog ? { clip: testVP || gameClip(aspect), near: fv[0], far: fv[1], colour: fv.slice(2) } : null;
        if (skyShown && V.lights.skyOn) {
            const e = eyeOf(vp);
            renderer.draw(V.skyRsp.batches, mul4(vp, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, e[0], e[1] - 10, e[2], 1]));
            renderer.clearDepth();
        }
        renderer.draw(opaque, vp);
        renderer.draw(V.propRsp.batches, vp);
        renderer.draw(V.actorRsp.batches, vp);
        renderer.draw(xlu, vp);
        updateLabels(vp);
        const all = V.batches.concat(V.propRsp.batches, V.actorRsp.batches);
        noteTextures(all, V.mem);
        const tex = new Set();
        for (const b of all) if (b.material.tex0) tex.add(b.material.tex0.data.hash);
        const shown = roomIso ? (roomIso.actor ? 1 : 0) : showActors ? V.actors.length : 0;
        $('status').textContent = (exportNote ? exportNote + ' · ' : '') + C.MAP_NAMES[V.h.map] + ' · room ' + V.room.index + ' · ' + V.room.instances.length + ' objects · ' + shown + (shown === 1 ? ' actor · ' : ' actors · ') + (V.out.triCount + V.propRsp.triCount + V.actorRsp.triCount) + ' triangles · ' + tex.size + ' textures' + (roomIso ? ' · showing one' : '');
    }

    /** Fly the camera (the same keys as MARO's viewer): along the ground, whichever way it looks. */
    function fly(dt) {
        if (!keys.size) return;
        const k = c => keys.has(c), speed = cam.dist * 0.8 * (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 3 : 1) * dt;
        const f = (k('KeyW') || k('ArrowUp') ? 1 : 0) - (k('KeyS') || k('ArrowDown') ? 1 : 0), s = (k('KeyD') || k('ArrowRight') ? 1 : 0) - (k('KeyA') || k('ArrowLeft') ? 1 : 0);
        const u = (k('KeyE') || k('Space') ? 1 : 0) - (k('KeyQ') || k('KeyC') ? 1 : 0);
        const sy = Math.sin(cam.yaw), cy = Math.cos(cam.yaw);
        cam.target[0] += (-sy * f + cy * s) * speed;
        cam.target[2] += (-cy * f - sy * s) * speed;
        cam.target[1] += u * speed;
    }

    function buildAnimList() {
        const box = $('anims');
        box.textContent = '';
        $('animCount').textContent = '(' + animList.length + ')';
        animList.forEach(a => {
            const d = document.createElement('div');
            d.textContent = String(a.id).padStart(2, '0') + ' ' + String(a.frames).padStart(3) + 'f ' + a.count + ' bones' + (a.rate > 1 ? ' ×' + a.rate : '');
            if (a.note) { const e = document.createElement('em'); e.textContent = ' ' + a.note; d.append(e); }
            d.dataset.id = a.id;
            d.onclick = () => selectAnim(a.id);
            box.append(d);
        });
        filterAnimList();
    }

    function filterAnimList() {
        const q = animQuery.trim().toLowerCase();
        for (const d of $('anims').children) d.style.display = !q || d.textContent.toLowerCase().includes(q) ? '' : 'none';
    }

    /** Brian's LoadBrianAnimation: his bank at 0x80200000. A monster's keys are already in its set's file. */
    function selectAnim(id) {
        chosen.lastAnim = id;
        const a = animList[id];
        if (a.bankStart) mem.map(0x200000, rom.subarray(a.bankStart, a.bankEnd), 'animbank');
        const entry = C.readAnimEntry(mem, a.entryAddr);
        model = { entry, parts: C.readParts(mem, entry) };
        current = a;
        frame = 0; total = 0; carry = 0;
        if (ended) { ended = false; setPlaying(true); }      // it stopped by itself, so the next animation plays
        $('scrub').max = entry.frames - 1;
        for (const d of $('anims').children) d.classList.toggle('sel', +d.dataset.id === id);
        selBone = -1;
        updateProps();
        refreshPanels();
    }

    function updateProps() {
        const p = $('props'), m = chosen;
        p.textContent = '';
        const add = (k, v) => { const t = document.createElement('dt'); t.textContent = k; const d = document.createElement('dd'); d.textContent = v; p.append(t, d); };
        if (m.kind === 'brian') {
            add('Mesh ROM', '0x869620-0x86F6F0');
            add('Mesh RAM', '0x80206000');
            add('Bank ROM', hex(current.bankStart) + '-' + hex(current.bankEnd));
            add('Bank RAM', '0x80200000');
        } else if (m.kind === 'npc') {
            add('Found in', m.places.join(', '));
            add('Placed', m.users.length + (m.users.length === 1 ? ' time' : ' times'));
            add('First at', 'map ' + m.users[0].map + ' room ' + m.users[0].room + ' #' + m.users[0].index);
            add('Model in', m.blob ? 'NPC blob ' + m.area + ' ' + hex(m.blob[0]) + '-' + hex(m.blob[1]) : m.shannon ? 'Shannon 0xA70350-0xA77F10' : 'held objects');
            add('Model RAM', hex(m.md));
            add('Game scale', m.scale.toFixed(3));
        } else if (m.kind === 'boss') {
            add('Found in', m.places[0]);
            add('Boss number', m.number);
            add('Map / room', m.map + ' / ' + m.room);
            add('Model ID', m.id);
            add('File ROM', hex(m.start) + '-' + hex(m.end));
            add('File RAM', hex(0x80000000 + C.BOSSES.fileRam));
            add('Game scale', m.scale.toFixed(3));
        } else {
            add('Found in', m.places.join(', '));
            add('ROM set', m.set);
            add('Model ID', m.id);
            add('Set file ROM', hex(m.start) + '-' + hex(m.end));
            add('Set file RAM', hex(MON_BASE));
            add('Game scale', m.scale.toFixed(3));
        }
        add('Animation', current.id);
        add('Entry', hex(current.entryAddr));
        add('Parts table', hex(model.entry.partsAddr));
        add('Frames', model.entry.frames);
        add('Game rate', '×' + current.rate + (current.rateNote ? ' (' + current.rateNote + ')' : ''));
        add('Bones', model.entry.count);
    }

    // ---- the right-hand tabs
    function setTab(t) {
        activeTab = t;
        for (const b of $('tabs').children) b.classList.toggle('on', b.dataset.tab === t);
        for (const p of document.querySelectorAll('.panel')) p.classList.toggle('on', p.id === 'panel-' + t);
        refreshPanels();
    }

    function refreshPanels() {
        if (activeTab === 'bones' && model) updateBones();
        if (activeTab === 'dls') updateDLs();
        if (activeTab === 'edits') updateEdits();
        if (activeTab === 'tex') drawTextures();
    }

    function updateBones() {
        const box = $('bones');
        box.textContent = '';
        const walk = (i, depth) => {
            const q = model.parts[i], d = document.createElement('div');
            const dl = q.dlistFrames ? 'per frame' : (q.dlist >= 0 && mem.u32(model.entry.dlistsAddr + q.dlist * 4) ? 'DL ' + q.dlist : 'no DL');
            d.textContent = '\u00A0'.repeat(depth * 2) + i + ' ' + dl;
            d.className = i === selBone ? 'sel' : '';
            d.onclick = () => { selBone = i === selBone ? -1 : i; if (selBone >= 0 && !showSkeleton) { showSkeleton = true; $('tSkel').classList.add('on'); } updateBones(); };
            box.append(d);
            model.parts.forEach((c, n) => { if (c.parent === i + 1) walk(n, depth + 1); });
        };
        model.parts.forEach((q, i) => { if (q.parent === 0) walk(i, 0); });
        const info = $('boneInfo');
        info.textContent = '';
        if (selBone < 0 || !model.parts[selBone]) return;
        const q = model.parts[selBone];
        const add = (k, v) => { const t = document.createElement('dt'); t.textContent = k; const v2 = document.createElement('dd'); v2.textContent = v; info.append(t, v2); };
        add('Bone', selBone);
        add('Parent', q.parent ? q.parent - 1 : 'root');
        add('Pivot', q.pivot.map(v => v.toFixed(1)).join(', '));
        add('Display list', q.dlistFrames ? ModelExport.partLists(mem, q).join(', ') + ' by frame' : q.dlist >= 0 ? q.dlist : 'none');
        add('Keys', q.keyCount);
        add('Key data', hex(q.keysAddr));
    }

    /** Every list in the table this animation uses, as far as any animation reaches: the table's own length is not stored. */
    function readDlTable() {
        const table = model.entry.dlistsAddr, cache = chosen.dlCache || (chosen.dlCache = {});
        if (cache[table]) return cache[table];
        let high = -1;
        for (const a of animList) {
            if (a.bankStart) mem.map(0x200000, rom.subarray(a.bankStart, a.bankEnd), 'animbank');
            const e = C.readAnimEntry(mem, a.entryAddr);
            if (e.dlistsAddr !== table) continue;
            for (const p of C.readParts(mem, e)) for (const d of ModelExport.partLists(mem, p)) high = Math.max(high, d);
        }
        if (current && current.bankStart) mem.map(0x200000, rom.subarray(current.bankStart, current.bankEnd), 'animbank');
        const out = cache[table] = [];
        for (let i = 0; i <= high; i++) out.push(mem.u32(table + i * 4));
        return out;
    }

    function updateDLs() {
        const box = $('dlBox');
        box.textContent = '';
        const hint = t => { const p = document.createElement('p'); p.className = 'hint'; p.textContent = t; box.append(p); };
        if (mapView) { updateRoomObjects(box, hint); return; }
        if (!model) return;
        dlTable = readDlTable();
        hint(dlTable.length + ' entries in the table at ' + hex(model.entry.dlistsAddr) + '. Click one to draw only that list, with the matrix of the bone that uses it.');
        const grid = document.createElement('div');
        grid.className = 'dlgrid';
        const btn = (label, value, off) => {
            const b = document.createElement('button');
            b.textContent = label;
            b.className = dlIso === value ? 'on' : '';
            b.disabled = !!off;
            if (off) b.title = 'Empty: this entry has no list';
            b.onclick = () => { dlIso = value; wantFrame = true; updateDLs(); };
            grid.append(b);
        };
        btn('All', null);
        dlTable.forEach((a, i) => btn('DL ' + i, i, !a));
        box.append(grid);
        if (dlIso !== null) hint('List address ' + hex(dlTable[dlIso]) + '. It draws only in animations whose parts use it.');
    }

    function updateRoomObjects(box, hint) {
        const V = mapView, R = V.room;
        hint(R.instances.length + ' placed objects and ' + V.actors.length + ' actors. Click one to draw only it.');
        const list = document.createElement('div');
        list.className = 'objlist';
        const KIND = k => (k === 0 || k === 8 ? 'model' : k < 4 ? 'floating' : k === 0x7F || k === 0x80 ? 'billboard' : k === 0x10 ? 'prop' : k === 0x11 || k === 0x12 ? 'flame' : k >= 0x40 && k < 0x46 ? 'scrolling' : k === 0x82 ? 'spinning' : k >= 0x81 ? 'emitter' : 'kind ' + k.toString(16));
        const row = (label, note, sel, fn) => {
            const d = document.createElement('div');
            d.textContent = label + ' ';
            const e = document.createElement('em');
            e.textContent = note;
            d.append(e);
            d.className = sel ? 'sel' : '';
            d.onclick = fn;
            list.append(d);
        };
        const pick = iso => { roomIso = iso; resetTextures(); compileRoom(); wantFrame = true; updateDLs(); };
        row('All', 'the whole room', !roomIso, () => pick(null));
        for (const A of V.actors) row(A.name, A.kind, roomIso && roomIso.actor === A, () => pick({ kind: 'actor', actor: A }));
        for (const id of R.instances) {
            const t = R.transforms[id], k = C.modelKind(t.flags);
            row('#' + id, KIND(k) + ' ' + t.index, roomIso && roomIso.id === id, () => pick({ kind: 'model', id }));
        }
        box.append(list);
    }

    // ---- textures of what is on screen. A model's come from all of its lists at once; a room's from what it draws.
    function resetTextures() { seenTex = new Map(); selTex = null; selRow = null; $('texPreview').textContent = ''; $('texGrid').textContent = ''; $('texNote').textContent = ''; }

    function noteTextures(batches, memory) {
        let grew = false;
        for (const b of batches) {
            for (const t of [b.material.tex0, b.material.tex1]) {
                if (!t) continue;
                const rom_ = t.src ? memory.romOffset(t.src, rom) : -1, pal = t.palSrc ? memory.romOffset(t.palSrc, rom) : -1, key = rom_ + '|' + (t.fmt === 2 ? pal : -1);
                let e = seenTex.get(key);
                if (!e) {
                    e = { tex: t, rom: rom_, pal, row: rom_ >= 0 ? TT.findRow(rom_, t.fmt === 2 ? pal : null) : null, tints: new Map() };
                    seenTex.set(key, e);
                    grew = true;
                }
                // The colours the game multiplies this texture by, each with the display list commands that hold it: one grey texture can draw in several.
                const m = b.material, q = m.two ? [m.combine.c0, m.combine.c1] : [m.combine.c0], prim = m.prim.slice(0, 3);
                if ((t.fmt === 3 || t.fmt === 4 || prim.some(v => v !== 255)) && q.some(c => [c.a, c.b, c.c, c.d].includes('PRIM')) && m.primAddr !== null) {
                    const at = memory.romOffset(m.primAddr, rom);
                    if (at >= 0) {
                        const k = prim.join();
                        if (!e.tints.has(k)) { e.tints.set(k, new Set()); grew = true; }
                        e.tints.get(k).add(at);
                    }
                }
            }
        }
        if (grew && activeTab === 'tex') drawTextures();
    }

    /** Everything this model's animations can draw, not only what has played so far (a blink's closed eyes, say). */
    function seedTextures() {
        const R = new C.Rsp(mem), done = new Set();
        R.setState(ACTOR_STATE);
        R.useLighting = false;
        try {
            for (const a of animList) {
                if (a.bankStart) mem.map(0x200000, rom.subarray(a.bankStart, a.bankEnd), 'animbank');
                const e = C.readAnimEntry(mem, a.entryAddr);
                for (const p of C.readParts(mem, e)) for (const d of ModelExport.partLists(mem, p)) {
                    const addr = mem.u32(e.dlistsAddr + d * 4);
                    if (addr && !done.has(addr)) { done.add(addr); R.run(addr); }
                }
            }
        } finally { if (current && current.bankStart) mem.map(0x200000, rom.subarray(current.bankStart, current.bankEnd), 'animbank'); }
        noteTextures(R.batches, mem);
    }

    const FORMAT = ['RGBA', 'YUV', 'CI', 'IA', 'I'];
    window.eltaleSeen = () => [...seenTex.values()].map(e => { const img = ModelExport.tileImage(e.tex); return { rom: e.rom, pal: e.tex.fmt === 2 ? e.pal : -1, fmt: FORMAT[e.tex.fmt], siz: 4 << e.tex.siz, w: img.w, h: img.h, file: e.row && e.row.file }; });     // for the tests
    const stemOf = () => (source === 'tex' ? (texFolder || 'textures').replaceAll('/', '_') : fileStem());
    const say = t => { exportNote = t; $('texNote').textContent = t; $('status').textContent = t; };

    function rgbaCanvas(w, h, px) {
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px), w, h), 0, 0);
        return c;
    }
    /** A row's picture is the one the Texture Tool exports; a texture no row knows shows as the tile the game draws. */
    function entryCanvas(e) {
        if (e.row) return rgbaCanvas(e.row.w, e.row.h, TT.decode(rom, e.row));
        const img = ModelExport.tileImage(e.tex);
        return rgbaCanvas(img.w, img.h, img.px);
    }

    function drawTextures() {
        const grid = $('texGrid');
        grid.textContent = '';
        $('exportAll').textContent = source === 'tex' ? 'Export this folder' : 'Export all (' + seenTex.size + ')';
        $('exportAll').disabled = source !== 'tex' && !seenTex.size;
        if (source === 'tex') { $('texHint').textContent = selRow ? '' : 'Click a texture.'; drawTexDetail(); return; }
        $('texHint').textContent = (mapView ? seenTex.size + ' textures in this room as shown. ' : seenTex.size + ' textures in this model. ') + 'Click one to save or replace it. An orange edge means replaced.';
        for (const [key, e] of seenTex) {
            const c = entryCanvas(e);
            c.className = (selTex === key ? 'sel' : '') + (e.row && mod.edited.has(e.row) ? ' edited' : '');
            c.title = FORMAT[e.tex.fmt] + (4 << e.tex.siz);
            c.onclick = () => { selTex = key; selRow = e.row; drawTextures(); };
            c.ondragover = ev => ev.preventDefault();
            c.ondrop = ev => dropOnto(ev, e.row);
            grid.append(c);
        }
        drawTexDetail();
    }

    function dropOnto(ev, row) {
        ev.preventDefault();
        ev.stopPropagation();
        const f = ev.dataTransfer.files[0];
        if (f && row) f.arrayBuffer().then(b => replaceTexture(row, new Uint8Array(b), f.name));
    }

    function drawTexDetail() {
        const box = $('texPreview');
        box.textContent = '';
        const e = source === 'tex' ? (selRow ? { row: selRow, rom: selRow.rom, pal: selRow.pal } : null) : seenTex.get(selTex);
        if (!e) return;
        box.append(entryCanvas(e));
        const info = document.createElement('dl');
        const add = (k, v) => { const t = document.createElement('dt'); t.textContent = k; const d = document.createElement('dd'); d.textContent = v; info.append(t, d); };
        const R = e.row;
        if (R) {
            add('Size', R.w + ' × ' + R.h);
            if (e.tex) { const img = ModelExport.tileImage(e.tex); if (img.w !== R.w || img.h !== R.h) add('Drawn as', img.w + ' × ' + img.h); }
            add('Format', R.fmt + R.siz);
            add('ROM', hex(R.rom));
            if (R.pal !== null) add('Palette ROM', hex(R.pal));
            if (R.ram) add('RAM', hex(R.ram));
            add('Folder', R.folder);
            add('File', R.file);
            if (R.users) add('Used by', R.users);
            if (R.note) add('Note', R.note);
        } else {
            const img = ModelExport.tileImage(e.tex);
            add('Size', img.w + ' × ' + img.h);
            add('Format', FORMAT[e.tex.fmt] + (4 << e.tex.siz));
            add('ROM', e.rom >= 0 ? hex(e.rom) : 'not from the ROM file');
        }
        box.append(info);
        const row = document.createElement('div');
        row.className = 'btnrow';
        const btn = (label, fn, off, title) => { const b = document.createElement('button'); b.textContent = label; b.onclick = fn; b.disabled = !!off; if (title) b.title = title; row.append(b); return b; };
        btn('Save this texture', async () => {
            if (R) save(await TT.writePng(R.w, R.h, TT.decode(rom, R)), R.file, 'image/png');
            else { const img = ModelExport.tileImage(e.tex); save(ModelExport.encodePng(img.w, img.h, img.px), 'tex_' + e.tex.data.hash.toString(16) + '.png', 'image/png'); }
        });
        btn('Replace…', () => { replaceFor = R; $('replaceInput').value = ''; $('replaceInput').click(); }, !R, R ? 'A PNG of the same size. It goes in the working folder; your file stays where it is.' : 'The Texture Tool has no file for this one');
        if (R && mod.edited.has(R)) btn('Undo replace', () => undoReplace(R));
        box.append(row);
        if (R && (R.fmt === 'I' || R.fmt === 'IA')) {
            const p = document.createElement('p');
            p.className = 'hint';
            p.textContent = 'A grey texture: a replacement keeps only its brightness' + (R.fmt === 'IA' ? ' and transparency' : '') + '. ' + (e.tints && e.tints.size ? 'The game colours it, so its colours are here instead:' : source === 'tex' ? 'Open it on its model to change its colour.' : 'The game colours it some other way, so its colour can\u2019t be changed here.');
            box.append(p);
        }
        if (e.tints) for (const [k, places] of e.tints) box.append(tintRow(k, places));
    }

    const toHex = rgb => '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('');
    function tintRow(key, places) {
        const row = document.createElement('div'), pick = document.createElement('input'), label = document.createElement('span'), rgb = key.split(',').map(Number);
        const list = [...places], changed = list.filter(o => mod.tints[o.toString(16)]);
        row.className = 'tintrow' + (changed.length ? ' changed' : '');
        pick.type = 'color';
        pick.value = toHex(rgb);
        pick.title = 'The colour the game multiplies this texture by';
        label.textContent = rgb.join(', ') + (changed.length ? ' (changed)' : '');
        pick.onchange = async () => {
            const v = parseInt(pick.value.slice(1), 16);
            for (const o of list) mod.tints[o.toString(16)] = [v >> 16 & 255, v >> 8 & 255, v & 255];
            await saveTints();
        };
        row.append(pick, label);
        if (changed.length) {
            const undo = document.createElement('button');
            undo.textContent = 'Undo';
            undo.onclick = async () => { for (const o of list) delete mod.tints[o.toString(16)]; await saveTints(); };
            row.append(undo);
        }
        return row;
    }
    async function saveTints() {
        await work.setTints(mod.tints);
        await refreshEdits();
    }

    function buildFolderList(box, q) {
        const folders = new Map();
        for (const t of TT.records) {
            if (!folders.has(t.folder)) folders.set(t.folder, { rows: [], hit: false });
            const f = folders.get(t.folder);
            f.rows.push(t);
            if (!q || t.folder.toLowerCase().includes(q) || t.file.toLowerCase().includes(q) || t.users.toLowerCase().includes(q)) f.hit = true;
        }
        let head = null;
        for (const [name, f] of folders) {
            if (!f.hit) continue;
            const top = name.split('/')[0];
            if (top !== head) {
                head = top;
                const h = document.createElement('div');
                h.className = 'group';
                h.textContent = top;
                box.append(h);
            }
            const d = document.createElement('div');
            d.className = 'row' + (name === texFolder ? ' sel' : '');
            const label = document.createElement('span');
            label.textContent = name.includes('/') ? name.slice(top.length + 1) : name;
            const n = document.createElement('em');
            n.textContent = f.rows.length;
            d.append(label, n);
            d.onclick = () => openFolder(name);
            box.append(d);
        }
    }

    function chooseTextures() {
        source = 'tex';
        model = null; mapView = null; chosen = null;
        $('labels').textContent = '';
        document.body.classList.remove('map-mode');
        document.body.classList.add('tex-mode');
        for (const b of $('leftTabs').children) b.classList.toggle('on', b.dataset.side === 'textures');
        $('modelFilter').placeholder = 'Filter by folder, file, offset or user';
        $('modelFilter').value = ''; labelFilter = '';
        $('listTitle').textContent = 'Textures';
        animQuery = ''; $('animFilter').value = '';
        if (activeTab !== 'edits') setTab('tex');
        openFolder(texFolder || TT.records[0].folder);
    }

    function openFolder(name) {
        texFolder = name;
        buildModelList();
        const rows = TT.records.filter(t => t.folder === name), list = $('anims'), cells = $('texCells');
        if (!selRow || selRow.folder !== name) selRow = null;
        list.textContent = ''; cells.textContent = '';
        $('animCount').textContent = rows.length;
        for (const t of rows) {
            const d = document.createElement('div');
            d.textContent = t.name ? t.name + ' ' + TT.hex6(t.rom) : TT.hex6(t.rom) + ' ' + t.fmt + t.siz + ' ' + t.w + '×' + t.h;
            d.dataset.rom = t.file;
            d.className = t === selRow ? 'sel' : '';
            d.onclick = () => selectRow(t);
            list.append(d);
            const fig = document.createElement('figure');
            fig.dataset.file = t.file;
            fig.className = t === selRow ? 'sel' : '';
            const c = rgbaCanvas(t.w, t.h, TT.decode(rom, t));
            if (mod.edited.has(t)) c.classList.add('edited');
            const cap = document.createElement('figcaption');
            cap.textContent = TT.hex6(t.rom) + ' ' + t.w + '×' + t.h;
            fig.append(c, cap);
            fig.onclick = () => selectRow(t);
            fig.ondragover = ev => ev.preventDefault();
            fig.ondrop = ev => dropOnto(ev, t);
            cells.append(fig);
        }
        filterAnimList();
        $('exportFolder').textContent = 'Export this folder (' + rows.length + ')';
        $('status').textContent = 'Textures · ' + name + ' · ' + rows.length + ' files';
        drawTextures();
    }

    function selectRow(t) {
        selRow = t;
        for (const d of $('anims').children) d.classList.toggle('sel', d.dataset.rom === t.file);
        for (const f of $('texCells').children) f.classList.toggle('sel', f.dataset.file === t.file);
        if (activeTab !== 'tex') setTab('tex'); else drawTextures();
    }

    // ---- replacing: the file goes in the working folder under the name the importer needs, so yours can be called anything
    const importer = () => {
        const strict = $('optStrict').checked, allCopies = $('optCopies').checked, k = +strict + ',' + +allCopies;
        return mod.importers[k] || (mod.importers[k] = new TT.Importer(origRom, { strict, allCopies }));
    };

    async function replaceTexture(row, bytes, label) {
        let img;
        try { img = await TT.readPng(bytes); }
        catch (e) { say(label + ': ' + e.message + '. Nothing changed.'); return; }
        if (img.w !== row.w || img.h !== row.h) { say(`${label} is ${img.w} × ${img.h}; this texture must stay ${row.w} × ${row.h}. Nothing changed.`); return; }
        await work.put(row.file, bytes);
        await refreshEdits();
        say('Replaced ' + row.file);
    }

    async function undoReplace(row) {
        for (const f of mod.files) {
            let t = null;
            try { t = importer().record(f.path.slice(f.path.lastIndexOf('/') + 1)); } catch (e) { /* a file that names nothing is shown in the Edits tab */ }
            if (t === row) await work.remove(f.path);
        }
        await refreshEdits();
        say('Back to the original: ' + row.file);
    }

    /** Read the working folder, work out the ROM it makes, and show it. */
    async function refreshEdits() {
        if (!rom) return;
        mod.files = await work.list();
        mod.tints = await work.getTints();
        mod.stamps = mod.files.map(f => f.path + '=' + f.stamp).sort().join() + JSON.stringify(mod.tints);
        mod.result = mod.files.length || Object.keys(mod.tints).length ? await importer().run(mod.files, mod.tints) : null;
        mod.edited = new Set();
        for (const f of mod.files) {
            try { mod.edited.add(importer().record(f.path.slice(f.path.lastIndexOf('/') + 1))); } catch (e) { /* listed as refused */ }
        }
        const target = $('optPreview').checked && mod.result && mod.result.rom ? mod.result.rom : origRom;
        let differs = false;
        for (let i = 0; i < target.length; i++) if (target[i] !== rom[i]) { differs = true; break; }
        if (differs) { rom.set(target); refreshView(); }
        else if (activeTab === 'tex') drawTextures();
        if (activeTab === 'tex') drawTextures();
        if (source === 'tex' && texFolder) openFolder(texFolder);
        updateEdits();
    }

    /** The same view again from the changed bytes: same camera, same frame, same room. */
    function refreshView() {
        mainRsp = new C.Rsp(mainMem);
        mainRsp.setState(ACTOR_STATE);
        mainRsp.useLighting = $('tLight').classList.contains('on');
        if (mem === mainMem) rsp = mainRsp;
        if (source === 'tex' || !chosen) return;
        const keep = { cam: { yaw: cam.yaw, pitch: cam.pitch, dist: cam.dist, target: cam.target.slice() }, frame, total, roomIso, dlIso, selBone, selTex, selRow };
        const query = animQuery, was = playing, room_ = mapView && mapView.room.index;
        selectModel(chosen);
        animQuery = query; $('animFilter').value = query; filterAnimList();
        frame = keep.frame; total = keep.total; dlIso = keep.dlIso; selBone = keep.selBone;
        if (mapView) {
            if (keep.roomIso) {
                roomIso = keep.roomIso.actor ? { kind: 'actor', actor: mapView.actors.find(A => A.addr === keep.roomIso.actor.addr && A.x === keep.roomIso.actor.x) } : keep.roomIso;
                compileRoom();
            }
        } else setPlaying(was);
        Object.assign(cam, keep.cam);
        wantFrame = false;
        selTex = keep.selTex; selRow = keep.selRow;
        refreshPanels();
    }

    function updateEdits() {
        const tintKeys = Object.keys(mod.tints), n = mod.files.length + tintKeys.length, r = mod.result, stopped = !!(r && r.refused && r.refused.length);
        $('tabEdits').textContent = n ? 'Edits (' + n + ')' : 'Edits';
        for (const id of ['buildTop', 'buildRom']) $(id).disabled = !n || stopped;
        $('buildTop').textContent = n ? 'Build ROM (' + n + ')' : 'Build ROM';
        $('saveReport').disabled = !(r && r.lines);
        $('workInfo').textContent = work.dir ? 'Using “' + work.label + '”. Replaced textures are in its import folder; you can edit them there. Exports go in export, new ROMs in build.'
            : work.waiting ? '“' + work.label + '” needs your permission again.'
            : work.canChoose ? 'Replaced textures are kept in this browser for now. Choose a folder to keep them on your computer as files.'
            : 'Replaced textures are kept in this browser. This browser cannot open a folder, so exports and new ROMs come as downloads.';
        $('workChoose').hidden = !work.canChoose;
        $('workChoose').textContent = work.dir ? 'Choose another' : 'Choose folder';
        $('workReconnect').hidden = !work.waiting;
        $('workLeave').hidden = !work.dir && !work.waiting;
        const list = $('editList');
        list.textContent = '';
        for (const f of mod.files.slice().sort((a, b) => (a.path < b.path ? -1 : 1))) {
            const d = document.createElement('div'), s = document.createElement('span'), x = document.createElement('button');
            let t = null;
            const name = f.path.slice(f.path.lastIndexOf('/') + 1);
            try { t = importer().record(name); } catch (e) { /* refused below */ }
            s.textContent = name; s.title = f.path;
            x.textContent = '×'; x.title = 'Take this one out';
            x.onclick = async ev => { ev.stopPropagation(); await work.remove(f.path); await refreshEdits(); };
            d.append(s, x);
            if (t) d.onclick = () => { chooseTextures(); openFolder(t.folder); selectRow(t); };
            list.append(d);
        }
        for (const o of tintKeys.sort()) {
            const d = document.createElement('div'), s = document.createElement('span'), x = document.createElement('button');
            s.textContent = 'colour at 0x' + o.toUpperCase() + ': ' + mod.tints[o].join(', ');
            x.textContent = '×'; x.title = 'Take this one out';
            x.onclick = async ev => { ev.stopPropagation(); delete mod.tints[o]; await saveTints(); };
            d.append(s, x);
            list.append(d);
        }
        if (!n) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = 'None yet. Pick a texture in the Textures tab and press Replace, or drop a PNG on it.'; list.append(p); }
        $('editNote').textContent = stopped ? 'A ROM can\u2019t be built until these are fixed:\n' + r.refused.join('\n') : '';
        $('report').textContent = r && r.lines ? r.lines.join('\n') : '';
    }

    async function chooseFolder() {
        const h = new URLSearchParams(location.search).get('opfs') ? await navigator.storage.getDirectory() : await showDirectoryPicker({ mode: 'readwrite', id: 'eltale-work' });
        await work.use(h);
        await refreshEdits();
    }

    /** Export all: to the working folder if there can be one, else as a zip. */
    async function exportEntries(rows, folderName, whole) {
        const noPicker = new URLSearchParams(location.search).get('nopicker');
        if (!work.dir && work.waiting && !noPicker) { try { await work.reconnect(); } catch (e) { /* asks below */ } }
        if (!work.dir && work.canChoose && !noPicker) {
            // No folder, for whatever reason, still gets the export: a cancel or a refusal falls through to the zip below.
            try { await chooseFolder(); } catch (e) { console.warn('No working folder:', e.name); }
        }
        const files = [];
        // Always the original pictures: what you replaced is already in the working folder, and an export's rom.json names the original ROM.
        if (whole) files.push(...await TT.exportAll(origRom, async (i, n) => { say('Exporting ' + i + ' of ' + n + '…'); await new Promise(r => setTimeout(r, 0)); }));
        else for (const t of rows) files.push([t.file, await TT.writePng(t.w, t.h, TT.decode(origRom, t))]);
        if (work.dir) {
            for (let i = 0; i < files.length; i++) {
                await work.writeOut('export/' + folderName + '/' + files[i][0], files[i][1]);
                if (i % 40 === 0) say('Writing ' + i + ' of ' + files.length + '…');
            }
            say('Wrote ' + files.length + ' files to ' + work.label + '/export/' + folderName);
        } else {
            save(ModelExport.makeZip(files.map(([n, b]) => [folderName + '/' + n, b])), folderName + '.zip', 'application/zip');
            say('Saved ' + folderName + '.zip (' + files.length + ' files)');
        }
    }

    /** Edited files by the names Export gave them: a folder, a zip, or a few PNGs. Only real changes are kept. */
    async function addFiles(files) {
        const all = [];
        for (const f of files) {
            if (f.path.toLowerCase().endsWith('.zip')) {
                try { all.push(...await TT.readZip(f.bytes)); } catch (e) { say(f.path + ': ' + e.message); return; }
            } else all.push(f);
        }
        const bad = [];
        let kept = 0, same = 0;
        for (const f of all) {
            const parts = f.path.replaceAll('\\', '/').split('/'), name = parts[parts.length - 1];
            if (!name.toLowerCase().endsWith('.png') || name === '_sheet.png' || parts.slice(0, -1).includes('palettes')) continue;
            try {
                const row = importer().record(name), img = await TT.readPng(f.bytes), { changes, info } = importer().encode(row, img);
                if (!changes.size && !Object.keys(info).length) { same++; continue; }
                await work.put(row.file, f.bytes);
                kept++;
            } catch (e) { bad.push(name + ': ' + e.message); }
        }
        await refreshEdits();
        say('Added ' + kept + (kept === 1 ? ' texture' : ' textures') + (same ? ', ' + same + ' unchanged left out' : '') + (bad.length ? ', ' + bad.length + ' refused' : '') + '.');
        $('editNote').textContent = bad.length ? 'Not added:\n' + bad.slice(0, 40).join('\n') + (bad.length > 40 ? '\n…and ' + (bad.length - 40) + ' more' : '') : $('editNote').textContent;
        setTab('edits');
    }

    async function buildRom() {
        await refreshEdits();
        const r = mod.result;
        if (!r || !r.rom) { setTab('edits'); return; }
        const stem = ($('romStem').value.trim().replace(/\.z64$/i, '').replace(/[\\/:*?"<>|]/g, '_')) || 'my_mod', text = r.lines.join('\n') + '\n';
        if (work.dir) {
            await work.writeOut('build/' + stem + '.z64', r.rom);
            await work.writeOut('build/' + stem + '.z64.report.txt', new TextEncoder().encode(text));
            say('Built ' + work.label + '/build/' + stem + '.z64');
        } else {
            save(r.rom, stem + '.z64', 'application/octet-stream');
            say('Built ' + stem + '.z64');
        }
        setTab('edits');
    }

    // ---- camera (a right-handed y-up world, as the game's)
    /** Column-major matrices: a after b. */
    function mul4(a, b) {
        const o = new Float32Array(16);
        for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
        return o;
    }
    /** Where a view-projection's camera is: the one point with clip x, y and w all zero. */
    function eyeOf(m) {
        const row = i => [m[i], m[4 + i], m[8 + i], -m[12 + i]], [a, b, c] = [row(0), row(1), row(3)];
        const det = (p, q, r) => p[0] * (q[1] * r[2] - q[2] * r[1]) - p[1] * (q[0] * r[2] - q[2] * r[0]) + p[2] * (q[0] * r[1] - q[1] * r[0]);
        const d = det(a, b, c), col = (v, i) => { const w = v.slice(0, 3); w[i] = v[3]; return w; };
        return [0, 1, 2].map(i => det(col(a, i), col(b, i), col(c, i)) / d);
    }
    /** The viewer's camera through the game's own near and far planes (15, 2400, the default camera setup's), for fog. */
    function gameClip() {
        const n = 15, f = 2400;
        return mul4([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, (f + n) / (n - f), -1, 0, 0, 2 * f * n / (n - f), 0], lastView);
    }

    /** With wide: a narrower picture still shows all the width a window of that shape shows. */
    function viewProj(aspect, wide) {
        const cp = Math.cos(cam.pitch), eye = [
            cam.target[0] + cam.dist * cp * Math.sin(cam.yaw),
            cam.target[1] + cam.dist * Math.sin(cam.pitch),
            cam.target[2] + cam.dist * cp * Math.cos(cam.yaw),
        ];
        const norm = v => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; };
        const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
        const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        const f = norm([cam.target[0] - eye[0], cam.target[1] - eye[1], cam.target[2] - eye[2]]);
        const s = norm(cross(f, [0, 1, 0])), u = cross(s, f);
        const fov = FOV, t = 1 / Math.tan(fov / 2) * (wide && aspect < wide ? aspect / wide : 1), n = Math.max(1, cam.dist / 100), ff = cam.dist * 30 + 2000;
        const V = [s[0], u[0], -f[0], 0, s[1], u[1], -f[1], 0, s[2], u[2], -f[2], 0, -dot(s, eye), -dot(u, eye), dot(f, eye), 1];
        lastView = V;
        const P = [t / aspect, 0, 0, 0, 0, t, 0, 0, 0, 0, (ff + n) / (n - ff), -1, 0, 0, 2 * ff * n / (n - ff), 0];
        const o = new Float32Array(16);
        for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
            o[c * 4 + r] = P[r] * V[c * 4] + P[4 + r] * V[c * 4 + 1] + P[8 + r] * V[c * 4 + 2] + P[12 + r] * V[c * 4 + 3];
        }
        return o;
    }
    const FOV = 35 * Math.PI / 180;
    const unit = v => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

    function poseAndRun() {
        const actor = testActor || C.buildActorMatrix(0, 0, 0, 1, 0, 0, 0);
        const pose = C.posePart(mem, model, actor, frame, total, inPlace ? 1 : 0);
        rsp.reset();
        rsp.setState(ACTOR_STATE);
        if (testLights) rsp.lights = testLights;
        if (testLook) { rsp.lookX = testLook.slice(0, 3); rsp.lookY = testLook.slice(3, 6); }
        else { const m = viewProj(1); rsp.lookX = unit([m[0], m[4], m[8]]); rsp.lookY = unit([m[1], m[5], m[9]]); }
        for (const p of pose) {
            rsp.mtx = p.mtx;
            if (dlIso === null) { if (p.dl) rsp.run(p.dl); continue; }
            // One list alone: the others still run for the state they leave, drawing nothing. A part that switches lists shows the chosen one.
            const lists = ModelExport.partLists(mem, model.parts[p.index]);
            if (lists.includes(dlIso) && dlTable[dlIso]) { rsp.run(dlTable[dlIso]); continue; }
            rsp.mute = true;
            if (p.dl) rsp.run(p.dl);
            rsp.mute = false;
        }
        return pose;
    }

    /** Fit the camera to the geometry drawn this frame. */
    function frameModel() { frameBatches(rsp.batches); }

    function frameBatches(batches) {
        let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        for (const b of batches) {
            for (let i = 0; i < b.data.length; i += 9) {
                for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], b.data[i + c]); hi[c] = Math.max(hi[c], b.data[i + c]); }
            }
        }
        if (lo[0] === Infinity) return;
        cam.target = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
        const r = Math.max(1, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2);
        const aspect = Math.max(0.2, Math.min(1, renderer.canvas.width / renderer.canvas.height));
        cam.dist = 1.02 * r / Math.sin(FOV / 2) / aspect;
    }

    function render() {
        if (testFrame) {
            renderer.resize();
            renderer.begin(testBg || [0.075, 0.09, 0.11]);
            renderer.draw(testFrame, testVP);
            return;
        }
        if (mapView) { renderMap(); return; }
        if (!model) return;
        const aspect = renderer.resize();
        let pose = poseAndRun();
        if (wantFrame && !testVP) { frameModel(); pose = poseAndRun(); }
        wantFrame = false;
        const vp = testVP || viewProj(aspect);
        renderer.begin(testBg || bgColor, transparent && !testBg ? 0 : 1);
        renderer.fog = null;
        renderer.draw(rsp.batches, vp);
        noteTextures(rsp.batches, mem);
        if (showSkeleton) {
            const pts = [];
            const at = i => { const m = pose.find(p => p.index === i).mtx, q = model.parts[i].pivot; return [q[0] * m[0] + q[1] * m[4] + q[2] * m[8] + m[12], q[0] * m[1] + q[1] * m[5] + q[2] * m[9] + m[13], q[0] * m[2] + q[1] * m[6] + q[2] * m[10] + m[14]]; };
            for (const q of model.parts) {
                if (q.parent === 0) continue;
                const a = at(q.parent - 1), b = at(q.index), hit = q.index === selBone;
                pts.push([a[0], a[1], a[2], hit ? 1 : 1, hit ? 0.2 : 0.82, hit ? 0.8 : 0.2], [b[0], b[1], b[2], hit ? 1 : 0.25, hit ? 0.2 : 0.9, hit ? 0.8 : 1]);
            }
            renderer.lines(pts, vp);
        }
        $('scrub').value = frame;
        $('frameLabel').textContent = 'frame ' + frame + ' / ' + (model.entry.frames - 1);
        const tex = new Set();
        for (const b of rsp.batches) { if (b.material.tex0) tex.add(b.material.tex0.data.hash); if (b.material.tex1) tex.add(b.material.tex1.data.hash); }
        $('status').textContent = (exportNote ? exportNote + ' · ' : '') + chosen.name + ' · animation ' + current.id + ' · ' + rsp.triCount + ' triangles · ' + model.entry.count + ' bones · ' + tex.size + ' textures this frame';
    }

    function setPlaying(on) {
        playing = on;
        $('play').textContent = on ? 'Pause' : 'Play';
    }

    /** n game ticks of AdvanceAnimation. */
    function step(n) {
        const s = { frame, total, ended: false };
        for (let i = 0; i < n && !s.ended; i++) C.advance(s, current.rate, model.entry.frames, loop);
        frame = s.frame; total = s.total;
        if (s.ended) { ended = true; carry = 0; setPlaying(false); }
    }

    function tick(now) {
        requestAnimationFrame(tick);
        if (testFrame) { render(); return; }
        const dt = Math.min(0.25, (now - last) / 1000 || 0);
        last = now;
        if (gifBusy) return;
        if (mapView || model) fly(dt);
        if (mapView) { if (!testVP) mapView.tick += dt * 30; render(); return; }
        if (!model) return;
        if (playing) {
            carry += dt * 30 * speed;            // the game draws at most 30 frames a second
            const whole = Math.floor(carry);
            if (whole > 0) { carry -= whole; step(whole); }
        }
        render();
    }

    // ---- input
    function openFile(file) {
        const r = new FileReader();
        $('err').textContent = 'Reading…';
        r.onload = () => {
            try { loadRom(new Uint8Array(r.result), file.name); $('err').textContent = ''; }
            catch (e) { $('open').classList.remove('hidden'); $('err').textContent = e.message; }
        };
        r.onerror = () => { $('err').textContent = 'Could not read that file.'; };
        r.readAsArrayBuffer(file);
    }
    $('romInput').onchange = e => { if (e.target.files[0]) openFile(e.target.files[0]); };
    addEventListener('dragover', e => { e.preventDefault(); $('open').classList.add('drag'); });
    addEventListener('dragleave', () => $('open').classList.remove('drag'));
    addEventListener('drop', e => {
        e.preventDefault();
        $('open').classList.remove('drag');
        const files = [...e.dataTransfer.files], entries = [...e.dataTransfer.items].map(i => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null)).filter(Boolean);
        if (!files.length) return;
        // A ROM, whenever one is dropped; with a ROM open, anything else is edited textures.
        if (!rom || (files.length === 1 && /\.(z64|v64|n64)$/i.test(files[0].name))) { openFile(files[0]); return; }
        const walk = async (en, prefix) => {
            if (en.isFile) { const f = await new Promise((ok, no) => en.file(ok, no)); return [{ path: prefix + en.name, bytes: new Uint8Array(await f.arrayBuffer()) }]; }
            const rd = en.createReader(), out = [];
            for (;;) {
                const batch = await new Promise((ok, no) => rd.readEntries(ok, no));
                if (!batch.length) return out;
                for (const c of batch) out.push(...await walk(c, prefix + en.name + '/'));
            }
        };
        Promise.all(entries.map(en => walk(en, ''))).then(l => addFiles(l.flat())).catch(err => say('That did not work: ' + err.message));
    });

    const toggle = (id, fn) => { $(id).onclick = () => { const on = $(id).classList.toggle('on'); fn(on); }; };
    toggle('tLight', on => { if (rsp) rsp.useLighting = on; if (mapView) compileRoom(); });
    toggle('tDoors', on => { showDoors = on; });
    toggle('tSky', on => { showSky = on; });
    toggle('tFog', on => { showFog = on; });
    toggle('tActors', on => { showActors = on; if (mapView) mapView.actorTick = -1; });
    toggle('tN64', on => { renderer.n64Depth = on; });
    toggle('tTransparent', on => { transparent = on; document.body.classList.toggle('transparent', on); });
    $('bgColor').oninput = e => { const v = parseInt(e.target.value.slice(1), 16); bgColor = [(v >> 16 & 255) / 255, (v >> 8 & 255) / 255, (v & 255) / 255]; };
    $('tabs').onclick = e => { if (e.target.dataset.tab) setTab(e.target.dataset.tab); };
    $('animFilter').oninput = e => { animQuery = e.target.value; filterAnimList(); };
    $('stop').onclick = () => { if (!model) return; frame = 0; total = 0; carry = 0; ended = false; setPlaying(false); };
    $('forget').onclick = () => forgetRom();
    $('gifSize').onchange = e => e.target.blur();
    addEventListener('keydown', e => {
        if (/^(INPUT|SELECT)$/.test(document.activeElement && document.activeElement.tagName)) return;
        if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
        keys.add(e.code);
    });
    addEventListener('keyup', e => keys.delete(e.code));
    addEventListener('blur', () => keys.clear());
    toggle('tFilter', on => { renderer.filter = on; });
    toggle('tCull', on => { renderer.cull = on; });
    toggle('tSkel', on => { showSkeleton = on; });
    toggle('tInPlace', on => { inPlace = on; });
    $('helpBtn').onclick = () => { $('help').hidden = false; };
    $('helpClose').onclick = () => { $('help').hidden = true; };
    $('help').onclick = e => { if (e.target === $('help')) $('help').hidden = true; };
    const oops = text => { const s = $('status'); if (s) s.textContent = 'Something went wrong: ' + text; };
    addEventListener('error', e => oops(e.message));
    addEventListener('unhandledrejection', e => oops(e.reason && e.reason.message ? e.reason.message : String(e.reason)));
    $('source').onchange = e => { if (rom) chooseSource(e.target.value); e.target.blur(); };
    $('leftTabs').onclick = e => {
        const side = e.target.dataset.side;
        if (!rom || !side) return;
        if (side === 'textures') chooseTextures();
        else chooseSource(side === 'maps' ? 'map' : modelSource);
    };
    const fail = e => { console.error(e); say('That did not work: ' + e.message); };
    $('exportAll').onclick = () => {
        const name = stemOf();
        exportEntries(source === 'tex' ? TT.records.filter(t => t.folder === texFolder) : [...seenTex.values()].map(e => e.row).filter(Boolean), name).catch(fail);
    };
    $('exportFolder').onclick = () => exportEntries(TT.records.filter(t => t.folder === texFolder), stemOf()).catch(fail);
    $('exportWhole').onclick = () => exportEntries(null, 'all_textures', true).catch(fail);
    $('replaceInput').onchange = async e => { const f = e.target.files[0]; if (f && replaceFor) replaceTexture(replaceFor, new Uint8Array(await f.arrayBuffer()), f.name).catch(fail); };
    const asFiles = async list => Promise.all([...list].map(async f => ({ path: f.webkitRelativePath || f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
    $('addFiles').onclick = () => { $('addFilesInput').value = ''; $('addFilesInput').click(); };
    $('addFolder').onclick = () => { $('addFolderInput').value = ''; $('addFolderInput').click(); };
    $('addFilesInput').onchange = async e => addFiles(await asFiles(e.target.files)).catch(fail);
    $('addFolderInput').onchange = async e => addFiles(await asFiles(e.target.files)).catch(fail);
    $('buildRom').onclick = () => buildRom().catch(fail);
    $('buildTop').onclick = () => buildRom().catch(fail);
    $('saveReport').onclick = () => { if (mod.result && mod.result.lines) save(new TextEncoder().encode(mod.result.lines.join('\n') + '\n'), ($('romStem').value.trim() || 'my_mod') + '.z64.report.txt', 'text/plain'); };
    for (const id of ['optPreview', 'optStrict', 'optCopies']) $(id).onchange = () => refreshEdits().catch(fail);
    $('workChoose').onclick = () => chooseFolder().catch(e => { if (e.name !== 'AbortError') fail(e); });
    $('workReconnect').onclick = async () => { await work.reconnect(); await refreshEdits(); };
    $('workLeave').onclick = async () => { await work.leaveFolder(); await refreshEdits(); };
    addEventListener('focus', async () => {      // edited in an image editor meanwhile?
        if (!rom || !work.dir) return;
        const stamps = (await work.list()).map(f => f.path + '=' + f.stamp).sort().join() + JSON.stringify(await work.getTints());
        if (stamps !== mod.stamps) refreshEdits().catch(fail);
    });
    // A focused button or list would take the flying keys: Space would press it again, the arrows would change it.
    addEventListener('click', e => { if (e.target.tagName === 'BUTTON') e.target.blur(); });
    $('modelFilter').oninput = e => { labelFilter = e.target.value; if (rom) buildModelList(); };
    $('play').onclick = () => {
        if (ended) { ended = false; carry = 0; setPlaying(true); return; }     // it is back on frame 0: play it again
        setPlaying(!playing);
    };
    toggle('tLoop', on => { loop = on; });
    $('scrub').oninput = e => { const f = +e.target.value; total += Math.round((f - frame) / current.rate); if (total < 0) total = 0; frame = f; ended = false; setPlaying(false); };
    $('speed').onchange = e => { speed = +e.target.value; e.target.blur(); };
    $('frameBtn').onclick = () => { cam.yaw = 0.45; cam.pitch = mapView ? 0.6 : 0.12; wantFrame = true; };
    $('savePng').onclick = () => {
        render();
        $('gl').toBlob(b => {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(b);
            const stem = chosen ? chosen.name.toLowerCase().replace(/[^a-z0-9]+/g, '_') : 'model';
            a.download = stem + (mapView ? '_room' + mapView.room.index : '_anim' + (current ? current.id : 0) + '_f' + frame) + '.png';
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        });
    };
    // ---- export: the file is built here and saved by the browser. Nothing leaves this computer.
    const fileStem = () => {
        const n = chosen ? chosen.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') : 'model';
        return mapView ? `map${String(mapView.h.map).padStart(2, '0')}_${n}_room${mapView.room.index}` : n;
    };
    function save(bytes, name, type) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([bytes], { type }));
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }
    /** A room through a fresh capture: world positions, baked shade, props at the viewer's angle. */
    function captureRoom() {
        const V = mapView, r = new C.Rsp(V.mem), look = viewAxes();
        r.capture = true;
        r.useLighting = $('tLight').classList.contains('on');
        r.lights = V.lights;
        r.lookX = look.slice(0, 3); r.lookY = look.slice(3, 6);
        const out = C.compileRoom(V.mem, r, V.h, V.room, rom[0x80060C88 - 0x7FFFF400 + V.m.map]);
        const tris = r.captured.slice();
        const p = new C.Rsp(V.mem);
        p.capture = true;
        p.useLighting = r.useLighting; p.lights = r.lights; p.lookX = r.lookX; p.lookY = r.lookY;
        C.compileProps(V.mem, p, V.h, out.groups.props, cam.yaw);
        const a = new C.Rsp(V.mem);
        a.capture = true;
        a.useLighting = r.useLighting; a.lights = C.actorLights(V.lights); a.lookX = r.lookX; a.lookY = r.lookY;
        if (showActors) C.compileActors(V.mem, a, V.actors, Math.floor(V.tick), ACTOR_STATE);
        return tris.concat(p.captured, a.captured);
    }

    // ---- GIF: one loop of this animation, as the game shows it
    async function exportGif() {
        if (!model || gifBusy) return;
        const [w, h] = $('gifSize').value.split(',').map(Number), clear = $('gifTransparent').checked, keep = { frame, total };
        const button = $('exportGif'), ticks = [];
        for (let f = 0; f < model.entry.frames; f += current.rate) ticks.push(f);
        gifBusy = true;
        button.disabled = true;
        if (wantFrame && !testVP) { poseAndRun(); frameModel(); wantFrame = false; }
        const wide = renderer.canvas.width / renderer.canvas.height;
        renderer.fixedSize = [w, h];
        renderer.resize();
        const bg = testBg || bgColor, shot = (f, t) => {
            frame = f; total = t;
            poseAndRun();
            renderer.begin(bg, clear ? 0 : 1);
            renderer.draw(rsp.batches, viewProj(w / h, wide));
            return renderer.read();
        };
        const pause = () => new Promise(r => setTimeout(r, 0));
        try {
            // One palette for the whole loop, from a few frames through it.
            const hist = new Uint32Array(32768), every = Math.max(1, Math.floor(ticks.length / 8));
            for (let i = 0; i < ticks.length; i += every) {
                const px = shot(ticks[i], i);
                for (let o = 0; o < px.length; o += 4) {
                    if (clear && px[o + 3] < 128) continue;
                    hist[(px[o] >> 3) | (px[o + 1] >> 3) << 5 | (px[o + 2] >> 3) << 10]++;
                }
                $('status').textContent = 'Making a GIF: colours…';
                await pause();
            }
            const palette = ModelExport.gifPalette(hist, clear ? 255 : 256);
            if (clear) palette.unshift([0, 0, 0]);
            const lut = new Int16Array(32768).fill(-1), first = clear ? 1 : 0;
            const nearest = c => {
                let best = first, gap = Infinity;
                const r = (c & 31) * 255 / 31, g = (c >> 5 & 31) * 255 / 31, b = (c >> 10 & 31) * 255 / 31;
                for (let i = first; i < palette.length; i++) { const p = palette[i], d = (p[0] - r) ** 2 + (p[1] - g) ** 2 + (p[2] - b) ** 2; if (d < gap) { gap = d; best = i; } }
                return best;
            };
            const gif = new ModelExport.GifWriter(w, h, palette, Math.max(2, Math.round(100 / 30 / speed)), clear ? 0 : -1), idx = new Uint8Array(w * h);
            for (let i = 0; i < ticks.length; i++) {
                const px = shot(ticks[i], i);
                for (let n = 0, o = 0; n < idx.length; n++, o += 4) {
                    if (clear && px[o + 3] < 128) { idx[n] = 0; continue; }
                    const c = (px[o] >> 3) | (px[o + 1] >> 3) << 5 | (px[o + 2] >> 3) << 10;
                    if (lut[c] < 0) lut[c] = nearest(c);
                    idx[n] = lut[c];
                }
                gif.addFrame(idx);
                if (i % 2 === 0) { $('status').textContent = 'Making a GIF: frame ' + (i + 1) + ' of ' + ticks.length; await pause(); }
            }
            const bytes = gif.finish(), name = fileStem() + '_a' + String(current.id).padStart(2, '0') + '.gif';
            if (new URLSearchParams(location.search).get('giftest')) {     // no download in a test: the bytes go on the page
                let s = '';
                for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
                document.body.dataset.gif = btoa(s);
            } else save(bytes, name, 'image/gif');
            exportNote = 'Saved ' + name + ' (' + ticks.length + ' frames, ' + (bytes.length / 1024).toFixed(0) + ' KB)';
        } catch (e) { exportNote = 'GIF failed: ' + e.message; console.error(e); }
        renderer.fixedSize = null;
        frame = keep.frame; total = keep.total;
        gifBusy = false;
        button.disabled = false;
    }
    /** What Brian, a monster or a boss hands the exporter. */
    function modelForExport() {
        const m = chosen;
        const anims = animList.map(a => ({
            prep: a.bankStart ? () => mem.map(0x200000, rom.subarray(a.bankStart, a.bankEnd), 'animbank') : () => {},
            addr: a.entryAddr, rate: a.rate, name: String(a.id).padStart(2, '0') + (a.note ? ' ' + a.note : ''),
        }));
        const out = ModelExport.buildModel({ mem, anims, state: ACTOR_STATE, flags: inPlace ? 1 : 0, scale: m.kind === 'brian' ? BRIAN_SCALE : m.scale, name: m.name });
        if (current.bankStart) mem.map(0x200000, rom.subarray(current.bankStart, current.bankEnd), 'animbank');     // the one on screen
        return out;
    }
    function exportGlb() {
        if (mapView) {
            const V = mapView, markers = V.labels.map(L => ({ name: L.e.textContent, x: L.x, y: L.y, z: L.z }));
            return [ModelExport.roomToGlb(`${C.MAP_NAMES[V.h.map]} room ${V.room.index}`, captureRoom(), markers), fileStem() + '.glb', 'model/gltf-binary'];
        }
        return [ModelExport.modelToGlb(modelForExport()), fileStem() + '.glb', 'model/gltf-binary'];
    }
    function exportObj() {
        if (mapView) return [ModelExport.trianglesToObjZip(fileStem(), captureRoom()), fileStem() + '_obj.zip', 'application/zip'];
        const r = new C.Rsp(mem), actor = C.buildActorMatrix(0, 0, 0, chosen.kind === 'brian' ? BRIAN_SCALE : chosen.scale, 0, 0, 0);
        r.capture = true;
        r.useLighting = false;
        r.reset();
        r.setState(ACTOR_STATE);
        for (const p of C.posePart(mem, model, actor, frame, total, inPlace ? 1 : 0)) { r.mtx = p.mtx; if (p.dl) r.run(p.dl); }
        return [ModelExport.trianglesToObjZip(fileStem() + '_a' + current.id + '_f' + frame, r.captured), fileStem() + '_a' + current.id + '_f' + frame + '_obj.zip', 'application/zip'];
    }
    function runExport(fn) {
        if (!rom || !chosen) return;
        const st = $('status');
        try {
            const [bytes, name, type] = fn();
            save(bytes, name, type);
            exportNote = 'Saved ' + name + ' (' + (bytes.length / 1024).toFixed(0) + ' KB)';
        } catch (e) { exportNote = 'Export failed: ' + e.message; console.error(e); }
        st.textContent = exportNote;
    }
    $('exportGlb').onclick = () => runExport(exportGlb);
    $('exportObj').onclick = () => runExport(exportObj);
    $('exportGif').onclick = () => exportGif();

    // ---- remembering the ROM: a copy in this browser's own storage, so it opens by itself next time. It never leaves this computer.
    const ROM_KEY = 'rom';
    const openDb = () => ToolStore.open();
    async function rememberRom(data, name) {
        try {
            const db = await openDb(), tx = db.transaction('files', 'readwrite');
            tx.objectStore('files').put({ name, bytes: data }, ROM_KEY);
            tx.oncomplete = () => { $('forget').hidden = false; db.close(); };
        } catch (e) { /* no storage here: it simply asks for the ROM next time */ }
    }
    async function restoreRom() {
        try {
            const db = await openDb();
            const got = await new Promise((ok, no) => { const r = db.transaction('files').objectStore('files').get(ROM_KEY); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
            db.close();
            if (got && !rom) { $('forget').hidden = false; loadRom(got.bytes, got.name, true); }
        } catch (e) { /* as above */ }
    }
    async function forgetRom() {
        try {
            const db = await openDb(), tx = db.transaction('files', 'readwrite');
            tx.objectStore('files').delete(ROM_KEY);
            tx.oncomplete = () => { $('forget').hidden = true; db.close(); };
        } catch (e) { $('forget').hidden = true; }
    }

    const canvas = $('gl');
    let drag = null;
    canvas.addEventListener('pointerdown', e => { canvas.setPointerCapture(e.pointerId); drag = { x: e.clientX, y: e.clientY, pan: e.button !== 0 || e.shiftKey }; });
    canvas.addEventListener('pointermove', e => {
        if (!drag) return;
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        drag.x = e.clientX; drag.y = e.clientY;
        if (drag.pan) {
            const k = cam.dist / 500, c = Math.cos(cam.yaw), s = Math.sin(cam.yaw);
            cam.target[0] -= dx * k * c; cam.target[2] += dx * k * s; cam.target[1] += dy * k;
        } else {
            cam.yaw -= dx * 0.01;
            cam.pitch = Math.max(-1.5, Math.min(1.5, cam.pitch + dy * 0.01));
        }
    });
    canvas.addEventListener('pointerup', () => { drag = null; });
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    canvas.addEventListener('wheel', e => { e.preventDefault(); cam.dist = Math.max(10, Math.min(20000, cam.dist * Math.exp(e.deltaY * 0.001))); }, { passive: false });

    try { renderer = new Renderer(canvas); } catch (e) { $('err').textContent = e.message; }
    requestAnimationFrame(tick);

    // Test hooks: ?rom=<file URL>&frame=N&anim=N&yaw=R holds a pose for a headless screenshot.
    const q = new URLSearchParams(location.search);
    if (q.get('ram')) {
        const x = new XMLHttpRequest();
        x.open('GET', q.get('ram'));
        x.responseType = 'arraybuffer';
        x.onload = () => {
            try {
                const m = new C.Mem();
                m.map(0, new Uint8Array(x.response), 'rdram');
                m.seg[1] = 0x95AF0;
                const r = new C.Rsp(m);
                r.run(parseInt(q.get('dl'), 16));
                testFrame = r.batches;
                testVP = new Float32Array(q.get('vp').split(',').map(Number));
                document.body.classList.add('bare');
                $('open').classList.add('hidden');
                if (q.get('bg')) testBg = q.get('bg').split(',').map(Number);
            } catch (e) { document.title = 'error: ' + e.message; $('err').textContent = e.message; }
        };
        x.send();
    } else if (q.get('rom')) {
        const x = new XMLHttpRequest();
        x.open('GET', q.get('rom'));
        x.responseType = 'arraybuffer';
        x.onload = () => {
            try {
                loadRom(new Uint8Array(x.response), 'test', !q.get('remember'));
                if (q.get('vp')) testVP = new Float32Array(q.get('vp').split(',').map(Number));
                if (q.get('propyaw')) testYaw = +q.get('propyaw');
                if (q.get('lookat')) testLook = q.get('lookat').split(',').map(Number);
                if (q.get('lights')) testLights = JSON.parse(q.get('lights'));
                if (q.get('map')) {
                    source = 'map';
                    selectModel(models.find(m => m.kind === 'map' && m.map === +q.get('map')));
                    if (q.get('room')) selectRoom(+q.get('room'));
                }
                if (q.get('npc')) {
                    source = 'npc';
                    selectModel(models.filter(m => m.kind === 'npc')[+q.get('npc') - 1]);
                }
                if (q.get('boss')) {
                    source = 'boss';
                    selectModel(models.find(m => m.kind === 'boss' && m.number === +q.get('boss')));
                }
                if (q.get('set')) {
                    source = 'monster';
                    selectModel(models.find(m => m.kind === 'monster' && m.set === +q.get('set') && m.id === +(q.get('monster') || 0)));
                }
                if (q.get('anim')) selectAnim(+q.get('anim'));
                if (!q.get('play')) setPlaying(false);
                if (q.get('noloop')) { loop = false; $('tLoop').classList.remove('on'); }
                frame = +(q.get('frame') || 0); total = +(q.get('total') || frame);
                if (q.get('yaw')) cam.yaw = +q.get('yaw');
                if (q.get('pitch')) cam.pitch = +q.get('pitch');
                if (q.get('skel')) showSkeleton = true;
                if (q.get('bare')) document.body.classList.add('bare');
                if (q.get('bg')) { testBg = q.get('bg').split(',').map(Number); showSky = false; }
                if (q.get('sky')) { showSky = true; testBg = null; }
                if (q.get('fog')) showFog = true;
                if (q.get('fogvals')) testFog = q.get('fogvals').split(',').map(Number);
                if (q.get('nocull')) renderer.cull = false;
                if (q.get('lookat')) testLook = q.get('lookat').split(',').map(Number);
                if (q.get('lights')) testLights = JSON.parse(q.get('lights'));
                if (q.get('vp')) testVP = new Float32Array(q.get('vp').split(',').map(Number));
                if (q.get('actor')) { const v = q.get('actor').split(',').map(Number); testActor = C.buildActorMatrix(v[0], v[1], v[2], v[3], v[4], v[5], v[6]); }
                wantFrame = !testVP;
                if (q.get('dist')) { wantFrame = false; cam.dist = +q.get('dist'); }
                if (q.get('tab')) setTab(q.get('tab'));
                if (q.get('dl')) { dlTable = readDlTable(); dlIso = +q.get('dl'); }
                if (q.get('noactors')) { showActors = false; $('tActors').classList.remove('on'); }
                if (q.get('transparent')) { transparent = true; document.body.classList.add('transparent'); $('tTransparent').classList.add('on'); }
                if (q.get('giftest')) { $('gifSize').value = q.get('giftest'); $('gifTransparent').checked = !!q.get('giftransparent'); setTimeout(exportGif, 300); }
                if (q.get('bone')) selBone = +q.get('bone');
                refreshPanels();
                if (q.get('exporttest')) {      // both exporters through the page's own path, with no download: the sizes show in the status line
                    const [g] = exportGlb(), [o] = exportObj();
                    exportNote = 'export test: glb ' + g.length + ' B, zip ' + o.length + ' B';
                }
            } catch (e) { $('err').textContent = e.message; }
        };
        x.send();
    } else if (q.get('forget')) forgetRom();
    else restoreRom();
})();
