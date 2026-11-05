"""Export every texture of the original Japanese Eltale Monsters ROM as PNGs in named folders, with a manifest.

    python export_textures.py "my rom.z64" [--out FOLDER] [--overwrite] [--no-sheets]

See README.md.
"""
import argparse, collections, csv, hashlib, os, re, struct, sys

try:
    from PIL import Image, ImageDraw
except ImportError:
    raise SystemExit('This tool needs Pillow, the Python image library. Install it with:  python -m pip install pillow')

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(os.path.dirname(HERE), 'text_engine'))
import rom_coverage as RC

ROOT = os.path.dirname(os.path.dirname(HERE))
NAMES_CSV = os.path.join(os.path.dirname(HERE), 'texture_names.csv')
if not os.path.exists(NAMES_CSV) and os.path.exists(os.path.join(HERE, 'texture_names.csv')):
    NAMES_CSV = os.path.join(HERE, 'texture_names.csv')             # the handed-out tool keeps everything in one folder
# only the scripts in analysis/scripts use the project's paths; a handed-out copy works from where it is run, wherever it was unpacked
IN_PROJECT = os.path.isdir(os.path.join(os.path.dirname(HERE), 'text_engine'))
JP_SHA1 = '4161b5c100ec82b0241b20ca8f81366e23564ccb'
FMT = ['RGBA', 'YUV', 'CI', 'IA', 'I', '?5', '?6', '?7']
BPP = [4, 8, 16, 32]
VALID = {('RGBA', 16), ('RGBA', 32), ('CI', 4), ('CI', 8), ('IA', 4), ('IA', 8), ('IA', 16), ('I', 4), ('I', 8)}
# every command the game's F3DEX 1.23 lists can hold; anything else ends a run of commands
OPS = {0x01, 0x03, 0x04, 0x05, 0x06, 0x07, 0xB1, 0xB2, 0xB3, 0xB4, 0xB5, 0xB6, 0xB7, 0xB8, 0xB9, 0xBA, 0xBB, 0xBC, 0xBD, 0xBE,
       0xBF, 0xC0, 0xE4, 0xE5, 0xE6, 0xE7, 0xE8, 0xE9, 0xED, 0xEE, 0xEF, 0xF0, 0xF2, 0xF3, 0xF4, 0xF5, 0xF6, 0xF7, 0xF8, 0xF9,
       0xFA, 0xFB, 0xFC, 0xFD, 0xFE, 0xFF}
TRI = {0xBF, 0xB1, 0xE4, 0xE5, 0x05, 0x06, 0x07}
SEG1 = 0x80095AF0
SKY_BUFFER, SKY_END = 0x8007C6B0, 0x800806B0
# labels for the per-monster folders, ids 0.. of each set (analysis/GAME_MECHANICS.md section 6: the MONSTER card's name list)
MONSTERS = [['Were Hare', 'Hell Hound', 'Man Eater', 'Big Mouth', 'Bumbershoot', 'Parassault', 'Ork Jr', 'Gremlin', 'Skeleton', 'Ghosthound',
             'Merrow', 'Wolf Goat'],
            ['Goblin', 'Frog King', 'Apophis', 'Mad Doll', 'Death Hugger', 'Kobold', 'Man Trap', 'Bat', 'Frog Knight', 'Marionasty', 'Dark Goblin',
             'Hot Lips', 'Ghost Stalker', 'Treant', 'Cockatrice'],
            ['Multieyes', 'Mimic', 'Crawler', 'Scorpion', 'Scarecrow', 'Wyvern', 'Skelebat', 'Cryshell', 'Bloodgel', 'Catapillar', 'Fishman'],
            ['Sandman', 'Were Cat', 'Nightmare', 'Blue Man', 'Winged Sunfish', 'Gloom Wing', 'Ogre', 'Rocky', 'Red Wyvern', 'Flamed Mane', 'Magma Fish',
             'Rose Knight', 'White Knight'],
            ['Ork', 'Ghost', 'Will O Wisp', 'Sprite', 'Jack O Lantern', 'Arachnoid', 'Lamia', 'Temptress', 'Pixie', 'Grangach', 'Thunder Gel', 'Termant'],
            ['Judgment', 'Pale Rider', 'Pin Head', 'Spriggan']]
FADING_PALETTE = 0x800806B0                 # a run-time faded copy of the sky record's palette
# RAM the game fills from ROM when entering play: the palette a list names here is really this one
# (0x800810B0 is gSkyFadedPalette: a faded copy of 0xD86170's; a capture of it sits within rounding of the first of the three)
RUNTIME = [(0x800808B0, 0x800810B0, None), (0x800810B0, 0x800814B0, 0xD86170), (0x800814B0, 0x80081AB0, 0xD86170), (0x80081AB0, 0x80081CB0, 0xD86770)]


def u16be(b, o):
    return struct.unpack('>H', b[o:o + 2])[0]


def identify(rom):
    """'jp' or 'en'; anything else stops here: an offset is only meaningful for a ROM we know"""
    if hashlib.sha1(rom).hexdigest() == JP_SHA1:
        return 'jp'
    return 'en' if rom[0xF80000:0xF80010] == b'ELTALE ENGLISH\0\0' else None


def load_rom(path):
    """the ROM as .z64 bytes; .v64 and .n64 byte orders are put right in memory, and the file is not touched"""
    try:
        with open(path, 'rb') as f:
            d = f.read()
    except OSError as e:
        raise SystemExit('Could not read the ROM "%s": %s. Nothing was written.' % (path, e.strerror or e))
    head = d[:4]
    if head == b'\x37\x80\x40\x12':                                    # .v64: each pair of bytes swapped
        o = bytearray(len(d))
        o[0::2], o[1::2] = d[1::2], d[0::2]
        return bytes(o)
    if head == b'\x40\x12\x37\x80':                                    # .n64: each four bytes reversed
        o = bytearray(len(d))
        o[0::4], o[1::4], o[2::4], o[3::4] = d[3::4], d[2::4], d[1::4], d[0::4]
        return bytes(o)
    return d


def not_original(path, rom):
    return ('"%s" is not the original Japanese ROM of Eltale Monsters (expected SHA-1 %s, this file is %s). A different dump or an already patched ROM has '
            'different contents, so the addresses here would be wrong. Nothing was written.' % (path, JP_SHA1, hashlib.sha1(rom).hexdigest()))


def slug(s):
    return re.sub(r'[^a-z0-9]+', '_', s.lower()).strip('_')


def monster_set_folder(i):
    """A monster set's folder, named after the maps it is met on."""
    return 'monsters/%d_%s' % (i, slug(' '.join(RC.MAP_NAMES[m].split(' (')[0] for m in RC.MONSTER_SET_MAPS[i])))


OLD_MONSTER_FOLDERS = ['0_holyplains', '1_dondoran', '2_bluecave', '3_desert', '4_normoon', '5_mammon']      # before 1.1.1


def retire_old_monster_folders(out):
    """An export written over an earlier one would otherwise keep these beside the new folders, as duplicates. Only their PNGs
    go, and --overwrite has already said edits inside an export are lost. Anything else stays, with the folders that hold it."""
    gone = 0
    for name in OLD_MONSTER_FOLDERS:
        top = os.path.join(out, 'monsters', name)
        for d, _, files in os.walk(top, topdown=False):
            for f in files:
                if f.lower().endswith('.png'):
                    os.remove(os.path.join(d, f))
                    gone += 1
            if not os.listdir(d):
                os.rmdir(d)
    return gone


class Region:
    def __init__(self, name, folder, rs, re_, ram, scan_from=None):
        self.name, self.folder, self.rs, self.re, self.ram = name, folder, rs, re_, ram
        self.scan_from = rs if scan_from is None else scan_from

    def has_ram(self, a):
        return self.ram <= a < self.ram + (self.re - self.rs)

    def rom(self, a):
        return a - self.ram + self.rs


class Exporter:
    def __init__(self, rom, layout=None):
        self.rom = rom
        self.layout = layout or rom             # the ROM whose tables give the block bounds (export_textures_en.py: the Japanese one)
        self.tex = {}                   # (rom, fmt, siz, palette rom) -> record
        self.rejected = collections.Counter()
        self.rejected_rows = []
        self.unresolved = collections.Counter()
        self.claim = {}                 # region name -> bytearray (1 texture, 2 commands, 3 vertices)
        self.names = {}
        self.regions = {}
        self.build_regions()

    def u32(self, o):
        return struct.unpack('>I', self.rom[o:o + 4])[0]

    def u16(self, o):
        return struct.unpack('>H', self.rom[o:o + 2])[0]

    # ---- the ROM's blocks, from rom_coverage.py's tables --------------------------------------------------------------
    def build_regions(self):
        ent = RC.entries(self.layout)
        R = self.regions

        def add(name, folder, rs, re_, ram, **kw):
            R[name] = Region(name, folder, rs, re_, ram, **kw)
        add('main', 'shared/main_segment', 0x1000, 0x71920, 0x80000400, scan_from=0x4C7B0)
        add('seg1', 'shared/segment1', 0x71920, 0x753F0, SEG1)
        add('common', 'shared/gameplay_common', 0x753F0, 0x851F0, 0x80100000)
        add('interiors_common', 'shared/interiors_common', 0x851F0, 0xC8DE0, 0x8010FE00)
        add('field_shared', 'shared/field_maps_3_5_7_12', 0x3E1090, 0x3F1BA0, 0x801E0000)
        add('brian', 'player/brian', 0x869620, 0x86F6F0, 0x80206000)
        add('held', 'npcs/held_objects', 0x86F6F0, 0x871D10, 0x8020C0D0)
        add('shannon', 'npcs/shannon', 0xA70350, 0xA77F10, 0x802A0000)
        add('spell', 'effects/spell_bank', 0xD490C0, 0xD74AC0, 0x800C0000)
        add('cutscene', 'ui/hud_and_battle', 0xD74AC0, 0xD86170, 0x8039ADB0)
        add('pak', 'ui/controller_pak', 0xDA4570, 0xDAB5F0, 0x80100000)
        add('title', 'title', 0xDAB5F0, 0xDC62B0, 0x8020C0D0)
        add('intro', 'intro', 0xDC62B0, 0xE22690, 0x8020C0D0)
        add('credits', 'credits', 0xE22690, 0xE420D0, 0x8020C0D0)
        add('event_a', 'credits/event_a', 0xE420D0, 0xE43780, 0x801C0000)
        add('event_b', 'credits/event_b', 0xE43780, 0xE5BF60, 0x801C0000)
        add('items', 'ui/item_icons', 0xD388B0, 0xD3A8B0, None)
        add('font', 'ui/font', 0xD3A930, 0xD490C0, 0x803245A0)
        for rows in ent.values():
            for s, e, nm, note in rows:
                if re.fullmatch(r'map_\d\d', nm):
                    i = int(nm[4:])
                    add(nm, 'maps/%02d_%s' % (i, slug(RC.MAP_NAMES[i].split(' (')[0])), s, e, self.u32(0x577B0 + i * 0x44 + 0xC))
                elif nm.startswith('npc_blob'):
                    add(nm, 'npcs/' + nm[4:], s, e, 0x8020E6F0)
                elif nm.startswith('monsters'):
                    i = int(nm[-1])
                    add(nm, monster_set_folder(i), s, e, 0x8020E6F0)
                elif nm.startswith('boss_'):
                    add(nm, 'bosses/' + nm[5:], s, e, 0x802A7BC0)
                elif nm.startswith('region_'):
                    add(nm, 'shared/' + nm, s, e, 0x801F8000)
                elif nm.startswith('sky_'):
                    add(nm, 'sky/' + nm[4:], s, e, None)
                elif nm.startswith('map_image') or nm.startswith('map_card'):
                    add(nm, 'ui/map_pages', s, e, None)

    def context(self, reg):
        """the blocks in RAM together with this one, own first"""
        R = self.regions
        always = ['main', 'seg1', 'cutscene', 'spell']
        n = reg.name
        out = [n]
        if re.fullmatch(r'map_\d\d', n):
            i = int(n[4:])
            out += ['region_%d' % self.rom[0x577B0 + i * 0x44 + 0x3F]] if i <= 25 else []
            out += ['interiors_common'] if 13 <= i <= 25 else []
            out += ['field_shared'] if i in (3, 5, 7, 12) else []
            out += ['common']
        elif n.startswith('npc_blob'):
            out += ['held', 'shannon', 'brian', 'common']
        elif n.startswith(('monsters', 'boss_', 'brian', 'held', 'shannon')):
            out += ['common']
        elif n.startswith('region_') or n == 'field_shared':
            out += ['common', 'interiors_common']
        return [R[x] for x in out + always if x in R and R[x] not in out]

    def resolve(self, ctx, addr):
        """(region, ROM offset) for an address in a list of this context, or (None, None)"""
        if addr >> 24 == 1:
            addr = addr - 0x01000000 + SEG1
        for r in ctx:
            if r.ram is not None and r.has_ram(addr):
                return r, r.rom(addr)
        return None, None

    # ---- records ------------------------------------------------------------------------------------------------------
    def region_of(self, o):
        for r in self.regions.values():
            if r.rs <= o < r.re and r.name != 'main':
                return r
        return self.regions['main'] if self.regions['main'].rs <= o < self.regions['main'].re else None

    def add(self, o, fmt, siz, w, h, pal=None, pal_src='', source='table', name=None, folder=None, stride=None, note='',
            user=None, clear0=False, slot=None):
        pal_n = {4: 16, 8: 256}.get(siz) if fmt == 'CI' else None
        key = (o, fmt, siz, pal)
        rec = self.tex.get(key)
        if rec is None:
            rec = self.tex[key] = dict(rom=o, fmt=fmt, siz=siz, w=w, h=h, pal=pal, pal_n=pal_n, pal_src=pal_src, source=source,
                                       name=name, folder=folder, stride=stride, note=note, users=set(), also=set(), clear0=clear0)
        elif source == 'table' or (w * h > rec['w'] * rec['h'] and rec['source'] != 'table'):
            if rec['w'] != w or rec['h'] != h:
                rec['also'].add('%dx%d' % (rec['w'], rec['h']))
            rec.update(w=w, h=h, stride=stride or rec['stride'], source=source)
            for k, v in (('name', name), ('folder', folder), ('note', note)):
                if v:
                    rec[k] = v
        elif rec['w'] != w or rec['h'] != h:
            rec['also'].add('%dx%d' % (w, h))
        if user:
            rec['users'].add(user)
        # what points at it, in the game's terms: the same slot in two ROMs is the same texture, wherever it sits (export_textures_en.py)
        rec.setdefault('slots', set())
        if slot or source == 'table':
            rec['slots'].add(slot or '%s/%s' % (folder, name))          # with its folder: intro and credits both have a page_02
        return rec

    # ---- display lists ------------------------------------------------------------------------------------------------
    def reject(self, why, reg, o):
        self.rejected[why] += 1
        if len(self.rejected_rows) < 200:
            self.rejected_rows.append((why, reg.name, o))

    def scan(self, reg):
        rom, ctx = self.rom, self.context(reg)
        claim = self.claim.setdefault(reg.name, bytearray(reg.re - reg.rs))
        img, load, tiles, tlut, pending, gen, run = None, None, {}, {}, [], 0, None
        rm = None

        def palette(rend):
            slot = 0x100 + (16 * rend['pal'] if rend['siz'] == 4 else 0)
            for tm, (addr, n, g) in tlut.items():
                if tm <= slot < tm + n:
                    return addr + 2 * (slot - tm), g
            return None, None

        def flush():
            nonlocal pending
            for args, rend in pending:
                addr, g = palette(rend)
                self.finish(reg, ctx, args, rend, addr, 'inherited' if addr is not None else '')
            pending = []

        def done_run(end):
            nonlocal run
            if run is not None and end - run >= 32:
                claim[run - reg.rs:end - reg.rs] = bytes(x or 2 for x in claim[run - reg.rs:end - reg.rs])
            run = None

        for o in range(reg.scan_from, reg.re - 7, 8):
            w0, w1 = struct.unpack('>II', rom[o:o + 8])
            c = w0 >> 24
            if c not in OPS or (c == 0xFD and (w0 & 0x0007F000)):
                flush()
                done_run(o)
                img, load, tiles, rm = None, None, {}, None
                gen += 1
                continue
            if run is None:
                run = o
            if c == 0xB9 and (w0 & 0xFFFF) == 0x031D:
                rm = w1
            if c == 0xFD:
                img = dict(addr=w1, fmt=FMT[(w0 >> 21) & 7], siz=BPP[(w0 >> 19) & 3], width=(w0 & 0xFFF) + 1)
            elif c == 0xF5:
                tiles[(w1 >> 24) & 7] = dict(fmt=FMT[(w0 >> 21) & 7], siz=BPP[(w0 >> 19) & 3], line=(w0 >> 9) & 0x1FF,
                                             tmem=w0 & 0x1FF, pal=(w1 >> 20) & 0xF)
            elif c == 0xF0 and img and ((w1 >> 24) & 7) in tiles:
                tm = tiles[(w1 >> 24) & 7]['tmem']
                tlut[tm] = (img['addr'], ((w1 >> 14) & 0x3FF) + 1, gen)
                still = []
                for args, rend in pending:
                    addr, g = palette(rend)
                    if addr is not None and g == gen:
                        self.finish(reg, ctx, args, rend, addr, 'dl')
                    else:
                        still.append((args, rend))
                pending = still
            elif c in (0xF3, 0xF4) and img and ((w1 >> 24) & 7) in tiles:
                load = dict(img=img, tmem=tiles[(w1 >> 24) & 7]['tmem'], at=o, rm=rm)
                if c == 0xF3:
                    load.update(kind='block', count=((w1 >> 12) & 0xFFF) + 1)
                else:
                    load.update(kind='tile', lrt=(w1 & 0xFFF) >> 2, ult=(w0 & 0xFFF) >> 2)
            elif c == 0xF2 and load and ((w1 >> 24) & 7) in tiles and tiles[(w1 >> 24) & 7]['tmem'] == load['tmem']:
                rend = tiles[(w1 >> 24) & 7]
                sz = (((w1 >> 12) & 0xFFF) - ((w0 >> 12) & 0xFFF), (w1 & 0xFFF) - (w0 & 0xFFF))
                args = (load, sz)
                load = None
                if rend['fmt'] == 'CI':
                    addr, g = palette(rend)
                    if addr is not None and g == gen:
                        self.finish(reg, ctx, args, rend, addr, 'dl')
                    else:
                        pending.append((args, dict(rend)))
                else:
                    self.finish(reg, ctx, args, rend, None, '')
            elif c in TRI or c == 0xB8:
                flush()
                if c == 0xB8:
                    gen += 1
                    img, load, tiles, rm = None, None, {}, None
            if c == 0x04 and reg.has_ram(w1):                   # G_VTX: 16 bytes a vertex
                v, n = w1 - reg.ram, (w0 >> 10) & 0x3F
                if n and v + 16 * n <= len(claim):
                    claim[v:v + 16 * n] = bytes(x or 3 for x in claim[v:v + 16 * n])
        flush()
        done_run(reg.re)

    def finish(self, reg, ctx, args, rend, pal_addr, pal_src):
        load, (dw, dh) = args
        at, img = load['at'], load['img']
        fmt, siz = rend['fmt'], rend['siz']
        if (fmt, siz) not in VALID:
            return self.reject('format %s%d' % (fmt, siz), reg, at)
        w, h = dw // 4 + 1, dh // 4 + 1
        stride = None
        if load['kind'] == 'block':
            n = load['count'] * img['siz'] // 8
            need = (w * h * siz + 7) // 8
            if dw < 0 or dh < 0 or not n - 8 < need <= n:
                line = rend['line'] * 8
                if line and n % line == 0:              # the tile wraps or mirrors past the image: the load tells the truth
                    w, h = line * 8 // siz, n // line
                else:
                    return self.reject('size disagrees with the load', reg, at)
        else:
            stride = img['width'] * img['siz'] // 8
            w, h = stride * 8 // siz, load['lrt'] + 1
        if not (0 < w <= 1024 and 0 < h <= 1024):
            return self.reject('size out of range', reg, at)
        addr = img['addr']
        if SKY_BUFFER <= addr < SKY_END:
            return                                      # the sky buffer: add_sky reads it through the sky records
        r, o = self.resolve(ctx, addr)
        if r is None:
            self.unresolved['%s 0x%08X %s%d %dx%d' % (reg.name, addr, fmt, siz, w, h)] += 1
            return self.reject('address in no block loaded with this one', reg, at)
        n = (stride or (w * siz + 7) // 8) * h
        if o + n > r.re:
            return self.reject('runs past its block', reg, at)
        pal, note = None, ''
        if fmt == 'CI' and pal_addr is not None:
            for lo, hi, src in RUNTIME:
                if lo <= pal_addr < hi:
                    pal = src + pal_addr - lo if src else None
                    pal_src = 'runtime' if src else 'runtime: sky record palette, not resolved (grey indices)'
                    note = 'the game fills this palette at run time from the ROM palette named here (fading it through the day)'
                    break
            else:
                if pal_addr >> 24 == 1:
                    pal_addr = pal_addr - 0x01000000 + SEG1
                pr, po = self.resolve(ctx, pal_addr)
                pal = po
                if pr is None:
                    pal_src = 'unresolved 0x%08X' % pal_addr
        rec = self.add(o, fmt, siz, w, h, pal, pal_src, 'dl', user=reg.name, stride=stride, note=note)
        if load.get('rm'):
            rec.setdefault('rm', set()).add(load['rm'])

    # ---- tables: art the code draws itself ----------------------------------------------------------------------------
    def m(self, a):
        return a - 0x7FFFF400

    def cs(self, a):
        return self.regions['cutscene'].rom(a)

    def add_menu(self):
        """the menu sheet: CI8, sizes 0x80060CB4, pixels 0x80060D74, palette 0x80061E98 (MENU_PAGES.md)"""
        K = {0: 'parchment', 1: 'hand_cursor', 4: 'feather', 5: 'dot', 6: 'page_arrow', 7: 'page_arrow', 0x14: 'slash', 0x15: 'percent',
             0x17: 'dash', 0x1A: 'title_status', 0x1B: 'label_hp', 0x1C: 'label_mp', 0x1D: 'label_def', 0x1E: 'label_agi',
             0x1F: 'label_exp', 0x20: 'label_exp', 0x21: 'title_environment', 0x22: 'label_message', 0x23: 'label_bgm', 0x24: 'bar',
             0x25: 'bar', 0x26: 'bar_pin', 0x27: 'bar_pin', 0x28: 'bar_pin', 0x29: 'label_max', 0x2A: 'label_min', 0x2B: 'title_map',
             0x2C: 'map_pin', 0x2D: 'title_elements', 0x2E: 'gem', 0x2F: 'gem', 0x30: 'gem', 0x31: 'gem', 0x32: 'bar_track',
             0x33: 'bar_fill', 0x56: 'label_min', 0x57: 'label_max'}
        K.update({0x0A + d: 'digit_%d' % d for d in range(10)})
        never = (0x02, 0x03, 0x08, 0x09, 0x16, 0x18, 0x1F, 0x26, 0x28, 0x34, 0x35)
        pal = self.m(0x80061E98)
        for k in range(0x58):
            w, h = self.rom[self.m(0x80060CB4) + 2 * k], self.rom[self.m(0x80060CB4) + 2 * k + 1]
            p = self.u32(self.m(0x80060D74) + 4 * k)
            if not (w and h and 0x80000400 <= p < 0x80071000):
                continue
            nm = 'kind%02X_%s' % (k, K.get(k, 'sprite'))
            self.add(self.m(p), 'CI', 8, w, h, pal, 'table', name=nm,
                     folder='ui/menu_sheet/unused_table_rows' if k in never else 'ui/menu_sheet',
                     note='no code draws this kind: its table row is a leftover and may not be a real image' if k in never else '')
        for i, (p, n) in enumerate(zip(struct.unpack('>4I', self.rom[self.m(0x80061634):self.m(0x80061634) + 16]),
                                       struct.unpack('>4i', self.rom[self.m(0x80061614):self.m(0x80061614) + 16]))):
            self.add(self.m(p), 'CI', 8, 64, n, self.m(0x80066E88), 'table', name='background_strip_%d' % i, folder='ui/menu_background')
        pals = struct.unpack('>4I', self.rom[self.m(0x800615E4):self.m(0x800615E4) + 16])
        tex = struct.unpack('>8I', self.rom[self.m(0x800615F4):self.m(0x800615F4) + 32])
        for layer in range(4):
            tw, th = (28, 56) if layer == 3 else (25, 50)
            for half in range(2):
                self.add(self.m(tex[layer * 2 + half]), 'CI', 8, tw, th, self.m(pals[layer]), 'table',
                         name='elements_gauge_layer%d_%s' % (layer, 'left' if half == 0 else 'right'), folder='ui/elements_gauge')
        # the window textures: D_800616D0 images, D_800616E4 (width, height, ...), palette D_80061850
        imgs = struct.unpack('>5I', self.rom[self.m(0x800616D0):self.m(0x800616D0) + 20])
        dims = struct.unpack('>30i', self.rom[self.m(0x800616E4):self.m(0x800616E4) + 120])
        for i, nm in enumerate(['window_fill', 'window_label', 'more_text_quill', 'window_edge', 'window_extra']):
            self.add(self.m(imgs[i]), 'CI', 8, dims[i * 6], dims[i * 6 + 1], self.m(0x80061850), 'table', name=nm, folder='ui/message_window')

    def add_items(self):
        c, g = 0xD384B0, 0xD386B0
        for i in range(32):
            nm = slug(RC.ITEM_NAMES[i]) if i < len(RC.ITEM_NAMES) else 'unused_slot_%02d' % i
            self.add(0xD388B0 + 0x100 * i, 'CI', 8, 16, 16, c, 'table', name='item_%02d_%s' % (i, nm), folder='ui/item_icons')
            self.add(0xD388B0 + 0x100 * i, 'CI', 8, 16, 16, g, 'table', name='item_%02d_%s_grey' % (i, nm), folder='ui/item_icons/grey')

    def add_font(self):
        n = (0xD490C0 - 0xD3A930) // 152
        self.add(0xD3A930, 'CI', 4, 304, n, 0xD3A8B0, 'table', name='font_sheet', folder='ui/font',
                 note='text palette 0 of 8 (0xD3A8B0); the game draws it 13 rows at a time')

    def add_map_pages(self):
        names = RC.MAP_IMAGE_NAMES
        for i in range(10):
            _, s, e = struct.unpack('>III', self.rom[0x620E4 + 12 * i:0x620E4 + 12 * i + 12])
            if i < 6:
                self.add(s + 512, 'CI', 8, 244, 185, s, 'table', name='map_%d_%s' % (i, slug(names[i])), folder='ui/map_pages')
        # the four word cards (entries 6-9): palette at the start of the entry, then the image, here one piece: both strip pointers
        # (0x8006156C) are the same and the second strip's height in the sizes (0x8006158C: w, rows, rows) is 0. RAM home 0x801C0000
        for k in range(4):
            _, s, e = struct.unpack('>III', self.rom[0x620E4 + 12 * (6 + k):0x620E4 + 12 * (6 + k) + 12])
            p1, p2 = struct.unpack('>II', self.rom[self.m(0x8006156C) + 8 * k:self.m(0x8006156C) + 8 * k + 8])
            w, h, h2 = self.rom[self.m(0x8006158C) + 3 * k:self.m(0x8006158C) + 3 * k + 3]
            self.add(s + p1 - 0x801C0000, 'CI', 8, w, h, s, 'table', name='map_card_%d' % (6 + k), folder='ui/map_pages')

    def add_hud(self):
        """the HudImage records in the cutscene bank: image, CI4 flag, width, height; each palette sits before its image"""
        names = {0x803A86F8: 'hud', 0x803A8718: 'info_window', 0x803A8728: 'status_symbols', 0x803A8738: 'spell_names'}
        for a in sorted(names):
            p, ci4, _, w, h = struct.unpack('>IHHII', self.rom[self.cs(a):self.cs(a) + 16])
            siz = 4 if ci4 else 8
            pal = self.cs(p) - (0x20 if ci4 else 0x200)
            self.add(self.cs(p), 'CI', siz, w, h, pal, 'table', name=names[a], folder='ui/hud_and_battle')
        self.add(self.cs(0x8039E290), 'RGBA', 16, 128, 10, name='digit_sheet', folder='ui/hud_and_battle')

    def add_effects(self):
        """gProjModelDefs (SPELLS.md table C, 20 B each): 16 or 32 square, I8 or CI8 with one of four palettes, frames back to back"""
        S = self.regions['spell']
        pals = [S.rom(a) for a in (0x800CAE68, 0x800CB068, 0x800CB268, 0x800CB468)]
        recs = []
        o = 0xD631B0
        for i in range(2000):
            flags, _, _, pal, tex = struct.unpack('>HHHHI', self.rom[o:o + 12])
            if tex and not (S.has_ram(tex) or tex >> 24 == 0x80):
                break
            if tex and S.has_ram(tex):
                recs.append((tex, flags, pal, i))
            o += 20
            if o >= 0xD74374:
                break
        starts = sorted({r[0] for r in recs})
        for tex, flags, pal, i in recs:
            size = 16 if flags & 1 else 32
            n = size * size
            frames = 1
            if flags & 0xC:
                nxt = next((a for a in starts if a > tex), S.ram + (S.re - S.rs))
                frames = max(1, min((nxt - tex) // n, 32))
            kw = dict(name='effect_%03d' % i, folder='effects/spell_textures', note='%d frame(s), one under another' % frames)
            if flags & 2:
                self.add(S.rom(tex), 'I', 8, size, size * frames, **kw)
            else:
                self.add(S.rom(tex), 'CI', 8, size, size * frames, pals[pal & 3], 'table', **kw)
        for a, nm, w, h, fmt, siz in ((0x800C3650, 'puff', 16, 16, 'I', 8), (0x800C3830, 'sparkle', 32, 32, 'I', 4),
                                      (0x800C3A30, 'framed_puff_2', 32, 32, 'I', 4), (0x800C3C30, 'framed_puff_1', 32, 32, 'I', 4),
                                      (0x800C3E30, 'framed_puff_0', 32, 32, 'I', 4), (0x800C4128, 'burst', 16, 16, 'I', 8),
                                      (0x800C47C0, 'ring', 8, 8, 'I', 8)):
            self.add(S.rom(a), fmt, siz, w, h, name=nm, folder='effects/particles')

    def dl_palette(self, ram):
        """the palette a short main-segment setup list loads (ROM offset or None)"""
        o = self.m(ram)
        last = None
        for _ in range(64):
            w0, w1 = struct.unpack('>II', self.rom[o:o + 8])
            if w0 >> 24 == 0xFD:
                last = w1
            elif w0 >> 24 == 0xF0 and last:
                return self.m(last) if last >> 24 == 0x80 and last < 0x80071000 else None
            elif w0 >> 24 == 0xB8:
                return None
            o += 8
        return None

    def add_main_props(self):
        """particles and flames whose images the code sets (E2A0.c, 147A0.c)"""
        pal = self.dl_palette(0x80060A38)
        for i in range(8):
            self.add(self.m(0x8005E9F8) + 0x400 * i, 'CI', 8, 32, 32, pal, 'table', name='map_dust_%d' % i, folder='effects/map_particles')
        self.add(self.m(0x80060AB8), 'RGBA', 16, 8, 16, name='dust_2', folder='effects/map_particles')
        for k, tbl in enumerate((0x8005E5B0, 0x8005E5D0)):
            setup = self.u32(self.m(0x8005E5A0 + 8 * k))
            pal = self.dl_palette(setup)
            seen = []
            for i in range(8):
                p = self.u32(self.m(tbl) + 4 * i)
                if p not in seen:
                    seen.append(p)
                    self.add(self.m(p), 'CI', 8, 16, 32, pal, 'table', name='flame_%d_frame_%d' % (k, i), folder='effects/flames')
        # four frames: UpdateSpiritSparkles' timer stops at 6 and indexes by timer >> 1. What follows them is game data, not images
        for i in range(4):
            self.add(self.m(0x8004E258) + 0x100 * i, 'I', 8, 16, 16, name='spirit_sparkle_%d' % i, folder='effects/particles')

    def add_title(self):
        """title overlay art by the constants of apply_title_logo.py and title_menu_english.py"""
        self.add(0xDB4810, 'CI', 8, 320, 224, 0xDB4610, 'table', name='title_background', folder='title')
        self.add(0xDB0C70, 'CI', 8, 194, 76, 0xDB0A70, 'table', name='title_logo', folder='title')
        self.add(0xDB0240, 'CI', 4, 176, 12, 0xDB0220, 'table', name='title_menu_words', folder='title')
        self.add(0xDAEC30, 'CI', 8, 128, 14, 0xDAEA30, 'table', name='title_arrows', folder='title')
        self.add(0xDAF530, 'CI', 8, 100, 15, 0xDAF330, 'table', name='push_start', folder='title')
        self.add(0xDB0668, 'CI', 4, 16, 12, 0xDB06C8, 'table', name='title_cursor', folder='title', clear0=True)
        self.add(0xDD29E0, 'CI', 8, 194, 76, 0xDD27E0, 'table', name='power_on_logo', folder='intro')

    def add_credits(self):
        """gSceneSequence (event blob B, 0x20 B a scene): +0x1C its images; CreditImage: 0x14 B, CI4, row stride to 16 px"""
        B = self.regions['event_b']
        done = set()
        for i in range(64):
            o = B.rom(0x801D8620) + i * 0x20
            if o + 0x20 > B.re:
                break
            a = self.u32(o + 0x1C)
            if not B.has_ram(a) or a in done:
                continue
            done.add(a)
            for k in range(64):
                r = B.rom(a) + k * 0x14
                start, dur, x, y, w, h, pal, img = struct.unpack('>HHhhhhII', self.rom[r:r + 0x14])
                if not (0 < w <= 320 and 0 < h <= 240 and pal >> 24 == 0x80 and img >> 24 == 0x80):
                    break
                if not (B.has_ram(pal) and B.has_ram(img)):
                    self.unresolved['credits image 0x%08X' % img] += 1
                    continue
                self.add(B.rom(img), 'CI', 4, w, h, B.rom(pal), 'table', name='scene%02d_image%02d' % (i, k), folder='credits',
                         stride=((w + 15) & ~15) // 2, clear0=True)

    def add_overlay_records(self):
        """the intro and credits overlays' 40-byte draw records (intro_text_layout.py): 0000FFFF, 0, page, flags, format word,
        x, y, band w, h, source x, y, full w, h, image, palette. One image is drawn in bands; the full size is the picture's."""
        for reg in (self.regions['intro'], self.regions['credits']):
            lo, hi = reg.ram, reg.ram + (reg.re - reg.rs)
            for o in range(reg.rs, reg.re - 40, 4):
                if self.rom[o:o + 8] != b'\x00\x00\xFF\xFF\x00\x00\x00\x00':
                    continue
                img, pal = self.u32(o + 0x20), self.u32(o + 0x24)
                fw, fh = self.u16(o + 0x1C), self.u16(o + 0x1E)
                bits = self.u16(o + 0x0C) >> 8
                if not (lo <= img < hi and lo <= pal < hi and bits in (4, 8) and 0 < fw <= 640 and 0 < fh <= 480):
                    continue
                # a CI4 image's rows are stored to a multiple of 16 pixels; the record's full width can be less (the epilogue scroll: 267 of 272)
                stored = (fw + 15) & ~15 if bits == 4 else fw
                self.add(reg.rom(img), 'CI', bits, stored, fh, reg.rom(pal), 'table', name='page_%02X' % self.u16(o + 0x08), folder=reg.folder,
                         stride=stored * bits // 8, note='drawn %d wide' % fw if stored != fw else '')
        # the Controller Pak warning screens, drawn by intro code: 208 wide, CI4 (pak_screen_english.py)
        for nm, img, pal, h in (('pak_not_connected', 0xE13430, 0xE161B8, 112), ('pak_power_off_and_connect', 0xE163C0, 0xE174D8, 42),
                                ('pak_full', 0xE176E0, 0xE1A468, 112), ('pak_connect_controller', 0xE1A670, 0xE1B788, 42),
                                ('pak_wrong_accessory', 0xE1B990, 0xE1E718, 112)):
            self.add(img, 'CI', 4, 208, h, pal, 'table', name=nm, folder='intro/pak_warnings')

    def add_pak_menu(self):
        """the Controller Pak menu's tile records at 0xDA8498 (334, pak_menu_english.py): x, y, w, h, 2 pad, image, palette; CI4,
        colour 0 skipped. The CPU blits them, so no display list names them."""
        P = self.regions['pak']
        for i in range(334):
            o = 0xDA8498 + 16 * i
            x, y, w, h, _, _, img, pal = struct.unpack('>hhBBBBII', self.rom[o:o + 16])
            self.add(P.rom(img), 'CI', 4, w, h, P.rom(pal), 'table', name='pak_tile', folder=P.folder, stride=(w + 1) // 2,
                     clear0=True, user='record %d' % i, slot='pak_tile_%03d' % i)
        self.add(0xDA9C00, 'CI', 4, 64, 203, 0xDA9BEC, 'table', name='pak_note_font', folder=P.folder, clear0=True,
                 note='no table gives this: start and width read from the bytes, height to the last row using only colours 0-3')

    def add_props(self):
        """DrawMapBillboards' scrolling props (E2A0.c sTextures, RGBA16, 32 wide; kinds 0x40-0x44 as the maps place them)"""
        for ram, h, reg, nm, used in ((0x801093B0, 64, 'common', 'scroll_kind40', 'maps 3, 5'), (0x8010A3B0, 64, 'common', 'scroll_kind41', 'maps 4, 5, 7, 10'),
                                      (0x80129D10, 32, 'map_32', 'scroll_kind42', 'map 32'), (0x80160B30, 64, 'map_17', 'scroll_kind43', 'map 17'),
                                      (0x8014DA40, 32, 'map_27', 'scroll_kind44', 'map 27')):
            r = self.regions[reg]
            self.add(r.rom(ram), 'RGBA', 16, 32, h, name=nm, note='scrolling prop, ' + used)

    def add_sky(self):
        """the 8 sky records: palettes +0, texture +0x800; each record's segment-1 list says how the buffer is cut into tiles"""
        for i in range(8):
            rec = self.u32(0x61848 + 8 * i)
            dl = self.u32(0x61848 + 8 * i + 4)
            reg = next(r for r in self.regions.values() if r.name == 'sky_%d' % i)
            o = self.regions['seg1'].rs + (dl & 0xFFFFFF)
            img, tiles, k = None, {}, 0
            for _ in range(600):
                w0, w1 = struct.unpack('>II', self.rom[o:o + 8])
                o += 8
                c = w0 >> 24
                if c == 0xB8:
                    break
                if c == 0xFD:
                    img = w1
                elif c == 0xF5:
                    tiles[(w1 >> 24) & 7] = BPP[(w0 >> 19) & 3]
                elif c == 0xF2 and ((w1 >> 24) & 7) == 0 and img and SKY_BUFFER <= img < SKY_END:
                    w, h = ((w1 >> 12) & 0xFFF) // 4 + 1, (w1 & 0xFFF) // 4 + 1
                    t = rec + 0x800 + img - SKY_BUFFER
                    if t + w * h <= reg.re:
                        self.add(t, 'CI', 8, w, h, rec, 'table', name='sky_%d_tile_%d' % (i, k), folder='sky/%d' % i,
                                 note='palette 0 of the record; the game fades between its palettes')
                        k += 1

    def walk_textures(self, reg, addr, out, depth=0):
        """the image addresses one display list loads, following its calls"""
        o = reg.rom(addr)
        for _ in range(4000):
            if o + 8 > reg.re:
                return
            w0, w1 = struct.unpack('>II', self.rom[o:o + 8])
            c = w0 >> 24
            o += 8
            if c not in OPS or c == 0xB8:
                return
            if c == 0xFD and reg.has_ram(w1):
                out.add(reg.rom(w1))
            elif c == 0x06 and reg.has_ram(w1) and depth < 8:
                self.walk_textures(reg, w1, out, depth + 1)
                if (w0 >> 16) & 0xFF:                   # a branch: the list ends there
                    return

    def assign_monsters(self):
        """Each monster's own folder. gMonsterSets (ROM 0x56DA0): word 2 points at gMonsterAnims; [id] is the monster's AnimEntry
        table; its first entry's +8 is the model's list of display lists (9D50.c, quest_types.h AnimEntry)."""
        self.monster_rows = []
        for i, names in enumerate(MONSTERS):
            reg = self.regions['monsters_%d' % i]
            table = self.u32(0x56DA0 + 0x14 * i + 8)
            owners = collections.defaultdict(set)
            for mid, nm in enumerate(names):
                anims = self.u32(reg.rom(table) + 4 * mid)
                dlists = self.u32(reg.rom(anims) + 8)
                images = set()
                n = 0
                while n < 128:
                    a = self.u32(reg.rom(dlists) + 4 * n)
                    if a == 0:                          # a part with no list of its own
                        n += 1
                        continue
                    if not reg.has_ram(a) or (self.u32(reg.rom(a)) >> 24) not in OPS:
                        break
                    self.walk_textures(reg, a, images)
                    n += 1
                for o in images:
                    owners[o].add(mid)
                self.monster_rows.append((reg.name, mid, nm, n, len(images)))
            for t in self.tex.values():
                if not (reg.rs <= t['rom'] < reg.re):
                    continue
                who = owners.get(t['rom'])
                if not who:
                    t['note'] = (t['note'] + ' no monster\'s display lists load it directly').strip()
                    continue
                t['users'] |= {'%s(%d)' % (slug(names[m]), m) for m in who}
                if len(who) == 1:
                    m = min(who)
                    t['folder'] = '%s/%02d_%s' % (reg.folder, m, slug(names[m]))
                else:
                    t['folder'] = reg.folder + '/shared_between_monsters'

    def collect(self):
        """find every texture: display lists, tables, monster owners (import_textures.py uses this too, so both read a file the same way)"""
        for reg in sorted(self.regions.values(), key=lambda r: r.rs):
            if reg.ram is not None:
                self.scan(reg)
        self.run_tables()
        self.assign_monsters()

    def run_tables(self):
        for f in (self.add_menu, self.add_items, self.add_font, self.add_map_pages, self.add_hud, self.add_effects,
                  self.add_main_props, self.add_title, self.add_credits, self.add_sky, self.add_overlay_records, self.add_pak_menu,
                  self.add_props):
            f()

    # ---- output -------------------------------------------------------------------------------------------------------
    def pal5551(self, o, n):
        out = []
        for i in range(n):
            v = self.u16(o + 2 * i)
            out.append(((v >> 11 & 31) * 255 // 31, (v >> 6 & 31) * 255 // 31, (v >> 1 & 31) * 255 // 31, 255 if v & 1 else 0))
        return out

    def raw(self, t):
        row = t['stride'] or (t['w'] * t['siz'] + 7) // 8
        return self.rom[t['rom']:t['rom'] + row * t['h']]

    def decode(self, t):
        w, h, fmt, siz = t['w'], t['h'], t['fmt'], t['siz']
        row = t['stride'] or (w * siz + 7) // 8
        rom, o = self.rom, t['rom']
        P = None
        if fmt == 'CI':
            if t['pal'] is not None:
                P = self.pal5551(t['pal'], t['pal_n'])
                if t['clear0']:                     # the game draws colour 0 as transparent here
                    P[0] = P[0][:3] + (0,)
            else:                                   # no palette found: grey ramp of the indices, flagged in the manifest
                P = [(c * 255 // (t['pal_n'] - 1),) * 3 + (255,) for c in range(t['pal_n'])]
        px = []
        for y in range(h):
            d = rom[o + y * row:o + (y + 1) * row]
            if siz == 4:
                v = [n for b in d for n in (b >> 4, b & 15)][:w]
                if fmt == 'CI':
                    px += [P[x] for x in v]
                elif fmt == 'I':
                    px += [(x * 17, x * 17, x * 17, 255) for x in v]
                else:
                    px += [((x >> 1) * 255 // 7,) * 3 + (255 if x & 1 else 0,) for x in v]
            elif siz == 8:
                if fmt == 'CI':
                    px += [P[x] for x in d[:w]]
                elif fmt == 'I':
                    px += [(x, x, x, 255) for x in d[:w]]
                else:
                    px += [((x >> 4) * 17,) * 3 + ((x & 15) * 17,) for x in d[:w]]
            elif siz == 16:
                for x in range(w):
                    a, b = d[2 * x], d[2 * x + 1]
                    if fmt == 'RGBA':
                        v = a << 8 | b
                        px.append(((v >> 11 & 31) * 255 // 31, (v >> 6 & 31) * 255 // 31, (v >> 1 & 31) * 255 // 31, 255 if v & 1 else 0))
                    else:
                        px.append((a, a, a, b))
            else:
                px += [tuple(d[4 * x:4 * x + 4]) for x in range(w)]
        if t.get('opaque'):
            px = [c[:3] + (255,) for c in px]
        im = Image.new('RGBA', (w, h))
        im.putdata(px)
        return im

    def finalize_names(self):
        tabled = {(t['rom'], t['fmt'], t['siz']) for t in self.tex.values() if t['source'] == 'table'}
        for k, t in list(self.tex.items()):
            if t['source'] == 'dl' and t['fmt'] == 'CI' and t['pal'] is None and (t['rom'], t['fmt'], t['siz']) in tabled:
                del self.tex[k]
        self.blank = 0
        for k, t in list(self.tex.items()):
            if not any(self.raw(t)):
                del self.tex[k]
                self.blank += 1
        for t in self.tex.values():
            if (t['fmt'], t['siz']) == ('RGBA', 16):
                raw = self.raw(t)
                clear = sum(1 for i in range(1, len(raw), 2) if not raw[i] & 1)
                modes = t.get('rm', ())
                # CVG_X_ALPHA (0x1000) is what lets texture alpha cut pixels out; every list here draws without it, so alpha is ignored
                ignored = bool(modes) and not any(m & 0x1000 for m in modes)
                if clear == len(raw) // 2:
                    t['opaque'] = True
                    t['note'] = (t['note'] + ' every stored alpha bit is 0; exported opaque' +
                                 (' (its render mode ignores alpha)' if ignored else ' (a fully clear image could not show otherwise; render mode not proof)')).strip()
                elif clear and ignored:
                    t['opaque'] = True
                    t['note'] = (t['note'] + ' %d%% of stored alpha bits are 0 but its render mode ignores alpha: exported opaque, as drawn' % (100 * clear // (len(raw) // 2))).strip()
        by_rom = collections.Counter(t['rom'] for t in self.tex.values())
        for t in self.tex.values():
            r = self.region_of(t['rom'])
            t['region'] = r.name if r else '?'
            t['ram'] = r.ram + t['rom'] - r.rs if r and r.ram is not None else None
            t['folder'] = t['folder'] or (r.folder if r else 'unsorted')
            nm = t['name'] or self.names.get(t['rom'], (None,))[0] or 'tex'
            t['name'] = nm
            fm = '%s%d' % (t['fmt'].lower(), t['siz'])
            f = '%s_%06X_%dx%d_%s' % (nm, t['rom'], t['w'], t['h'], fm)
            if by_rom[t['rom']] > 1 and t['pal'] is not None:
                f += '_pal%06X' % t['pal']
            t['file'] = f + '.png'

    def write(self, out, sheets=True):
        self.finalize_names()
        folders = collections.defaultdict(list)
        with open(os.path.join(out, 'manifest.csv'), 'w', newline='', encoding='utf-8') as fh:
            c = csv.writer(fh)
            c.writerow(['id', 'file', 'folder', 'name', 'name_source', 'rom', 'ram', 'format', 'width', 'height', 'row_bytes', 'bytes', 'palette_rom',
                        'palette_source', 'md5', 'used_by', 'also_loaded_as', 'render_mode', 'source', 'note'])
            for t in sorted(self.tex.values(), key=lambda t: (t['folder'], t['rom'])):
                d = os.path.join(out, *t['folder'].split('/'))
                os.makedirs(d, exist_ok=True)
                im = self.decode(t)
                im.save(os.path.join(d, t['file']))
                folders[t['folder']].append((t, im))
                raw = self.raw(t)
                src = self.names.get(t['rom'], (None, ''))[1] if t['source'] != 'table' else 'table'
                c.writerow(['0x%06X' % t['rom'], t['file'], t['folder'], '' if t['name'] == 'tex' else t['name'], src, '0x%06X' % t['rom'],
                            '0x%08X' % t['ram'] if t['ram'] else '', '%s%d' % (t['fmt'], t['siz']), t['w'], t['h'],
                            t['stride'] or (t['w'] * t['siz'] + 7) // 8, len(raw),
                            '0x%06X' % t['pal'] if t['pal'] is not None else '', t['pal_src'] or ('none found' if t['fmt'] == 'CI' else ''),
                            hashlib.md5(raw).hexdigest(), ' '.join(sorted(t['users'])), ' '.join(sorted(t['also'])),
                            ' '.join('%08X' % m for m in sorted(t.get('rm', ()))), t['source'], t['note']])
                self.claim_texture(t, len(raw))
        self.write_palettes(out)
        if sheets:
            for fo, rows in folders.items():
                self.sheet(rows, os.path.join(out, *fo.split('/'), '_sheet.png'))
        return folders

    def claim_texture(self, t, n):
        for name, reg in self.regions.items():
            if name in self.claim and reg.rs <= t['rom'] < reg.re:
                c = self.claim[name]
                a = t['rom'] - reg.rs
                c[a:a + n] = b'\x01' * min(n, len(c) - a)

    def write_palettes(self, out):
        d = os.path.join(out, 'palettes')
        os.makedirs(d, exist_ok=True)
        rows = [('menu_sheet', self.m(0x80061E98), 256), ('menu_background', self.m(0x80066E88), 256), ('message_window', self.m(0x80061850), 256),
                ('item_icons_colour', 0xD384B0, 256), ('item_icons_grey', 0xD386B0, 256), ('sky_day_cycle_0', 0xD86170, 256),
                ('sky_day_cycle_1', 0xD86370, 256), ('sky_day_cycle_2', 0xD86570, 256), ('rotating', 0xD86770, 256)]
        rows += [('text_%d' % i, 0xD3A8B0 + 0x20 * i, 16) for i in range(4)]
        for i in range(8):
            rec = self.u32(0x61848 + 8 * i)
            rows += [('sky_%d_palette_%d' % (i, k), rec + 0x200 * k, 256) for k in range(4)]
        for nm, o, n in rows:
            im = Image.new('RGBA', (16, n // 16))
            im.putdata(self.pal5551(o, n))
            im.resize((16 * 12, n // 16 * 12), Image.NEAREST).save(os.path.join(d, '%s_%06X.png' % (nm, o)))

    def sheet(self, rows, path):
        W, gap, scale = 1400, 6, 2 if max(i.width for _, i in rows) < 200 else 1
        bg = (40, 40, 70, 255)
        places, x, y, rowh = [], gap, gap, 0
        for t, im in rows:
            iw, ih = im.width * scale, im.height * scale
            cw = max(iw, 44)
            if x + cw + gap > W:
                x, y, rowh = gap, y + rowh + 12 + gap, 0
            places.append((t, im, x, y, iw, ih))
            x += cw + gap
            rowh = max(rowh, ih)
        out = Image.new('RGBA', (W, y + rowh + 14 + gap), bg)
        dr = ImageDraw.Draw(out)
        for t, im, x, y, iw, ih in places:
            out.alpha_composite(im.resize((iw, ih), Image.NEAREST), (x, y))
            dr.text((x, y + ih + 1), '%06X' % t.get('en_body', (t['rom'],))[0], fill=(220, 220, 220, 255))
        out.save(path)

    def coverage(self, out, folders):
        with open(os.path.join(out, 'coverage.txt'), 'w', encoding='utf-8') as f:
            f.write('Eltale Monsters (Japan): textures found, by file count and by what each block\'s bytes are.\n\n')
            n = sum(len(v) for v in folders.values())
            src = collections.Counter(t['source'] for t in self.tex.values())
            f.write('%d files in %d folders: %s\n' % (n, len(folders), ', '.join('%d from %s' % (v, k) for k, v in src.items())))
            pals = collections.Counter(t['pal_src'] or 'none found' for t in self.tex.values() if t['fmt'] == 'CI')
            f.write('CI textures by palette source: %s\n\n' % ', '.join('%s %d' % kv for kv in pals.most_common()))
            f.write('Left out because every byte is zero: %d\n' % self.blank)
            f.write('RGBA16 images exported opaque although stored alpha bits are 0: %d (see each note)\n\n' % sum(1 for t in self.tex.values() if t.get('opaque')))
            f.write('Monsters (set, id, name, display lists, images loaded):\n')
            for row in self.monster_rows:
                f.write('  %s %2d %-16s %3d %3d\n' % row)
            spans = sorted((t['rom'], t['rom'] + len(self.raw(t)), t['file'], t['folder']) for t in self.tex.values())
            over = [(a[2], b[2]) for a, b in zip(spans, spans[1:]) if b[0] < a[1] and a[0] != b[0] and 'unused_table_rows' not in a[3] + b[3]]
            f.write('\nFiles whose bytes overlap (one of each pair probably has a wrong size, or they are real sub-images): %d\n' % len(over))
            for a, b in over:
                f.write('  %s / %s\n' % (a, b))
            f.write('\nRejected display-list hits (data that looked like commands, or loads that could not be placed):\n')
            for k, v in self.rejected.most_common():
                f.write('  %5d  %s\n' % (v, k))
            if self.unresolved:
                f.write('\nAddresses no block explains:\n')
                for k, v in sorted(self.unresolved.items()):
                    f.write('  %s (x%d)\n' % (k, v))
            f.write('\nBytes by block (KB): texture / display list / vertices / other. "other" in models is geometry and animation;\n'
                    'the largest runs are listed so a missed image can be looked for.\n')
            for name, c in sorted(self.claim.items(), key=lambda kv: self.regions[kv[0]].rs):
                reg = self.regions[name]
                runs = []
                i, nb = 0, len(c)
                while i < nb:
                    if c[i] == 0:
                        j = i
                        while j < nb and c[j] == 0:
                            j += 1
                        if j - i >= 0x400:
                            runs.append((j - i, i))
                        i = j
                    else:
                        i += 1
                runs.sort(reverse=True)
                f.write('  %-18s 0x%06X %5d: tex %4d, dl %4d, vtx %4d, other %4d;  %s\n' % (
                    name, reg.rs, nb // 1024, c.count(1) // 1024, c.count(2) // 1024, c.count(3) // 1024, c.count(0) // 1024,
                    ' '.join('0x%06X+%X' % (reg.rs + o, l) for l, o in runs[:4])))


def seed_names(ex, quest_path):
    """Names from the Quest 64 decomp's yaml, kept only where the bytes are identical in Eltale's same block."""
    yaml = os.path.join(os.path.dirname(HERE), 'clones', 'Quest', 'quest64.us.yaml')
    if not os.path.exists(yaml):
        raise SystemExit('--seed-names needs the Quest 64 decomp next to this tool. The names file already holds its results. Nothing was written.')
    quest = open(quest_path, 'rb').read()
    pat = re.compile(r'\[0x([0-9A-Fa-f]+),\s*rgba16,\s*bosses/(\w+)/textures/(\w+)\.rgba16,\s*(\d+),\s*(\d+)\]')
    ex.names = {}
    rows = []
    want = {}
    for line in open(yaml, encoding='utf-8'):
        m = pat.search(line)
        if m:
            o, boss, nm, w, h = int(m[1], 16), m[2], m[3], int(m[4]), int(m[5])
            if not nm.startswith('unk'):
                want.setdefault(boss, []).append((o, nm, w, h))
    for boss, lst in want.items():
        r = ex.regions.get('boss_' + boss)
        if r is None:
            continue
        data = ex.rom[r.rs:r.re]
        for o, nm, w, h in lst:
            b = quest[o:o + w * h * 2]
            at = data.find(b)
            if at >= 0 and data.find(b, at + 1) < 0:
                rows.append((r.rs + at, nm, 'quest64 decomp yaml (Mallos31): bytes identical', '%s %dx%d' % (boss, w, h)))
    keep = []
    if os.path.exists(NAMES_CSV):
        keep = [r for r in csv.reader(open(NAMES_CSV, encoding='utf-8')) if r and r[0] != 'rom' and 'quest64 decomp yaml' not in r[2]]
    with open(NAMES_CSV, 'w', newline='', encoding='utf-8') as fh:
        c = csv.writer(fh)
        c.writerow(['rom', 'name', 'source', 'note'])
        for r in sorted(keep):
            c.writerow(r)
        for o, nm, src, note in sorted(rows):
            c.writerow(['0x%06X' % o, nm, src, note])
    print('names file: %d rows from Quest, %d kept' % (len(rows), len(keep)))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('rom', nargs='?', default=RC.JP_ROM if IN_PROJECT else None, help='your original Japanese ROM (.z64, .v64 or .n64)')
    ap.add_argument('--out', help='the folder to write (default: exported_textures)')
    ap.add_argument('--overwrite', action='store_true', help='write over an earlier export. Any edits made inside it are lost')
    ap.add_argument('--jp', default=RC.JP_ROM, help='the original Japanese ROM, when exporting the English release')
    ap.add_argument('--no-sheets', action='store_true')
    ap.add_argument('--seed-names', metavar='QUEST_ROM')
    a = ap.parse_args()
    if not a.rom:
        raise SystemExit('Give the path to your original Japanese ROM:  python export_textures.py "my rom.z64"')
    rom = load_rom(a.rom)
    kind = identify(rom)
    if kind is None:
        raise SystemExit(not_original(a.rom, rom))

    def out_folder(default):
        out = a.out or default
        if os.path.exists(os.path.join(out, 'manifest.csv')):
            if not a.overwrite:
                raise SystemExit('"%s" already holds an export, and any edits inside it would be lost. Choose another --out, or add --overwrite. Nothing was written.' % out)
            retire_old_monster_folders(out)     # only over a real export: a folder without a manifest may be someone's mod
        return out
    names = {}
    if os.path.exists(NAMES_CSV):
        for r in csv.DictReader(open(NAMES_CSV, encoding='utf-8')):
            names[int(r['rom'], 16)] = (slug(r['name']), r['source'])
    if kind == 'en':
        if a.seed_names:
            raise SystemExit('--seed-names works on the original Japanese ROM. Nothing was written.')
        try:
            import export_textures_en as EN
        except ImportError:
            raise SystemExit('"%s" is the English translation. This tool works on the original Japanese ROM only. Nothing was written.' % a.rom)
        jp = load_rom(a.jp)
        if identify(jp) != 'jp':
            raise SystemExit('%s is not the original Japanese ROM, which the English export needs for its IDs. Nothing was written.' % a.jp)
        out = out_folder(os.path.join(ROOT, 'temp', 'rom_export', 'en'))
        rows, counts, problems, ledger_ok, _ = EN.run(rom, jp, out, not a.no_sheets, names)
        print('%d rows -> %s\n%s' % (len(rows), out, ', '.join('%s %d' % kv for kv in counts.most_common())))
        print('ledger %s; %d problem(s): see coverage.txt' % ('matches' if ledger_ok else 'DOES NOT MATCH', len(problems)))
        return
    ex = Exporter(rom)
    if a.seed_names:
        return seed_names(ex, a.seed_names)
    a.out = out_folder(os.path.join(ROOT, 'temp', 'rom_export', 'jp') if IN_PROJECT else 'exported_textures')
    ex.names = names
    os.makedirs(a.out, exist_ok=True)
    import json
    with open(os.path.join(a.out, 'rom.json'), 'w', encoding='utf-8') as f:
        json.dump(dict(rom='the original Japanese ROM', sha1=JP_SHA1, ids_are_offsets_in='this ROM'), f, indent=1)
    ex.collect()
    folders = ex.write(a.out, not a.no_sheets)
    ex.coverage(a.out, folders)
    print('%d textures in %d folders -> %s' % (len(ex.tex), len(folders), os.path.abspath(a.out)))
    print('Copy the ones you want to change into a folder of your own and edit them there, keeping the same width and height, then:')
    print('  python import_textures.py my_folder --rom "%s" --out my_mod.z64' % a.rom)


if __name__ == '__main__':
    main()
