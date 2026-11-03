"""Put edited texture PNGs back into a new copy of the original Japanese ROM. Your ROM file is never changed.

    python import_textures.py MY_FOLDER --rom "my rom.z64" [--out my_mod.z64] [--strict] [--all-copies]

See README.md.
"""
import argparse, collections, hashlib, os, re, sys

try:
    from PIL import Image
except ImportError:
    raise SystemExit('This tool needs Pillow, the Python image library. Install it with:  python -m pip install pillow')

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(os.path.dirname(HERE), 'text_engine'))
import export_textures as ET
import n64crc
import rom_coverage as RC

ROOT = ET.ROOT
TAIL = re.compile(r'_([0-9A-F]{6})_(\d+)x(\d+)_([a-z]+)(\d+)(?:_pal([0-9A-F]{6}))?\.png$')
TO5 = lambda v: (v * 31 + 127) // 255


class Refused(Exception):
    """this file cannot be imported"""


def pixels(im):
    return list(im.get_flattened_data()) if hasattr(im, 'get_flattened_data') else list(im.getdata())


def key5(c):
    return TO5(c[0]), TO5(c[1]), TO5(c[2]), 1 if c[3] >= 128 else 0


class Importer:
    def __init__(self, rom, strict=False, all_copies=False):
        self.src, self.strict, self.all_copies = rom, strict, all_copies
        self.ex = ET.Exporter(rom)
        self.ex.collect()
        self.ex.finalize_names()
        self.by_key = collections.defaultdict(list)
        self.by_md5 = collections.defaultdict(set)
        for t in self.ex.tex.values():
            self.by_key[(t['rom'], t['fmt'].lower(), t['siz'])].append(t)
            self.by_md5[(hashlib.md5(self.ex.raw(t)).hexdigest(), t['fmt'], t['siz'], t['w'], t['h'])].add(t['rom'])

    def record(self, name):
        if name.startswith('en_'):
            raise Refused('it comes from the English export (en_): this importer builds on the original Japanese ROM only')
        m = TAIL.search(name)
        if not m:
            raise Refused('its name does not end in _<ROM offset>_<W>x<H>_<format>.png, so it cannot be matched to the ROM')
        o, w, h, fmt, siz, pal = int(m[1], 16), int(m[2]), int(m[3]), m[4], int(m[5]), m[6]
        rows = self.by_key.get((o, fmt, siz))
        if not rows:
            raise Refused('no exported texture has this offset and format (0x%06X, %s%d)' % (o, fmt, siz))
        if pal:
            rows = [t for t in rows if t['pal'] == int(pal, 16)]
        if len(rows) != 1:
            raise Refused('it does not pick out one exported texture (palette variants: keep the _pal part of the name)')
        return rows[0]

    def encode(self, t, im):
        """{ROM offset: new byte} for the texels that changed, plus counts for the report"""
        w, h, fmt, siz = t['w'], t['h'], t['fmt'], t['siz']
        if im.size != (w, h):
            raise Refused('it is %dx%d; it must stay %dx%d' % (im.width, im.height, w, h))
        new = pixels(im.convert('RGBA'))
        old = pixels(self.ex.decode(t))
        info = collections.Counter()
        out = {}
        if new == old:
            return out, info
        row = t['stride'] or (w * siz + 7) // 8
        rom, base = self.src, t['rom']
        pal, slots = None, None
        if fmt == 'CI':
            if t['pal'] is None:
                raise Refused('its palette is not known, so colours cannot be matched')
            pal = self.ex.pal5551(t['pal'], t['pal_n'])
            if t['clear0']:
                pal[0] = pal[0][:3] + (0,)
            slots = [(TO5(c[0]), TO5(c[1]), TO5(c[2]), 1 if c[3] else 0) for c in pal]

        def nibble(y, x, v):
            at = base + y * row + x // 2
            cur = out.get(at, rom[at])
            out[at] = (cur & 0x0F) | v << 4 if x % 2 == 0 else (cur & 0xF0) | v

        for i, (a, b) in enumerate(zip(old, new)):
            if a == b or (a[3] == 0 and b[3] == 0):             # an editor may clear the colour under a transparent pixel
                continue
            y, x = divmod(i, w)
            if (fmt, siz) == ('RGBA', 16):
                at = base + y * row + 2 * x
                cur = rom[at] << 8 | rom[at + 1]
                if t.get('opaque'):
                    if b[3] < 128:
                        info['erased in an opaque file: kept'] += 1
                        continue
                    alpha = cur & 1
                else:
                    alpha = 1 if b[3] >= 128 else 0
                r5, g5, b5, _ = key5(b)
                v = r5 << 11 | g5 << 6 | b5 << 1 | alpha
                if v != cur:
                    out[at], out[at + 1] = v >> 8, v & 255
                    info['texels'] += 1
            elif fmt == 'CI':
                k = key5(b)
                if k == key5(a) or (k[3] == 0 and key5(a)[3] == 0):
                    continue
                if k in slots:
                    idx = slots.index(k)
                else:
                    if self.strict:
                        raise Refused('pixel (%d, %d) uses a colour not in its palette (--strict)' % (x, y))
                    same = [n for n, s in enumerate(slots) if s[3] == k[3]]
                    if not same:
                        same = list(range(len(slots)))
                        info['no slot with the wanted transparency'] += 1
                    idx = min(same, key=lambda n: sum((slots[n][c] - k[c]) ** 2 for c in range(3)))
                    info['snapped to the nearest palette colour'] += 1
                if siz == 8:
                    out[base + y * row + x] = idx
                else:
                    nibble(y, x, idx)
                info['texels'] += 1
            elif (fmt, siz) == ('RGBA', 32):
                out.update({base + y * row + 4 * x + c: b[c] for c in range(4)})
                info['texels'] += 1
            else:                                               # I and IA: greyscale
                if len({b[0], b[1], b[2]}) > 1:
                    info['coloured pixels made grey'] += 1
                g = (b[0] * 299 + b[1] * 587 + b[2] * 114) // 1000
                if (fmt, siz) == ('I', 4):
                    nibble(y, x, (g + 8) // 17)
                elif (fmt, siz) == ('I', 8):
                    out[base + y * row + x] = g
                elif (fmt, siz) == ('IA', 4):
                    nibble(y, x, (g * 7 + 127) // 255 << 1 | (1 if b[3] >= 128 else 0))
                elif (fmt, siz) == ('IA', 8):
                    out[base + y * row + x] = (g + 8) // 17 << 4 | (b[3] + 8) // 17
                else:
                    out[base + y * row + 2 * x], out[base + y * row + 2 * x + 1] = g, b[3]
                info['texels'] += 1
        return {k: v for k, v in out.items() if rom[k] != v}, info

    def run(self, folder):
        """(ROM bytes, report lines); raises SystemExit with the list if anything is refused"""
        refused, done, ignored = [], [], 0
        read = 0
        writes = {}
        for d, _, files in sorted(os.walk(folder)):
            if os.path.basename(d) == 'palettes' or 'palettes' in os.path.relpath(d, folder).split(os.sep):
                continue
            for f in sorted(files):
                if not f.lower().endswith('.png'):
                    continue
                if f == '_sheet.png':
                    ignored += 1
                    continue
                path = os.path.join(d, f)
                read += 1
                try:
                    t = self.record(f)
                    with Image.open(path) as im:
                        im.load()
                        changes, info = self.encode(t, im)
                except Refused as e:
                    refused.append('%s: %s' % (os.path.relpath(path, folder), e))
                    continue
                except OSError as e:
                    refused.append('%s: unreadable (%s)' % (os.path.relpath(path, folder), e))
                    continue
                if not changes and not info:
                    continue
                key = (hashlib.md5(self.ex.raw(t)).hexdigest(), t['fmt'], t['siz'], t['w'], t['h'])
                others = sorted(self.by_md5[key] - {t['rom']})
                targets = dict(changes)
                if self.all_copies:
                    for o in others:
                        targets.update({k - t['rom'] + o: v for k, v in changes.items()})
                clash = next((k for k, v in targets.items() if k in writes and writes[k][1] != v), None)
                if clash is not None:
                    refused.append('%s: writes a different value to ROM 0x%06X than %s' % (os.path.relpath(path, folder), clash, writes[clash][0]))
                    continue
                for k, v in targets.items():
                    writes[k] = (f, v)
                done.append((f, t, changes, info, others))
        if not read:
            raise SystemExit('No texture PNGs found in "%s". Nothing was written.' % folder)
        if refused:
            raise SystemExit('Nothing was written. %d file(s) could not be imported:\n  ' % len(refused) + '\n  '.join(refused))
        rom = bytearray(self.src)
        for k, (_, v) in writes.items():
            rom[k] = v
        crc_changed = False
        if writes:
            before = bytes(rom[0x10:0x18])
            n64crc.fix(rom)
            crc_changed = bytes(rom[0x10:0x18]) != before
        return bytes(rom), self.report(done, writes, ignored, crc_changed)

    def report(self, done, writes, ignored, crc_changed):
        out = ['%d file(s) changed, %d ROM byte(s) written; header checksum %s.' % (len(done), len(writes), 'recomputed' if crc_changed else 'unchanged'), '']
        for f, t, changes, info, others in done:
            out.append('%s  (ROM 0x%06X, %d texels, %d bytes)' % (f, t['rom'], info['texels'], len(changes)))
            for k in sorted(info):
                if k != 'texels':
                    out.append('  %s: %d' % (k, info[k]))
            if t['pal_src'] == 'runtime':
                out.append('  its palette is faded at run time, so these colours will shift through the day')
            elif t['pal_src'] == 'inherited':
                out.append('  its palette was inferred, not read from its own list: check it in play')
            if others:
                out.append('  same art also at %s: %s' % (' '.join('0x%06X' % o for o in others),
                                                          'written too (--all-copies)' if self.all_copies else 'left alone (use --all-copies to change them)'))
        if not done:
            out.append('No edited pixels found: the new ROM is identical to the original.')
        return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('folder', help='the folder holding the edited PNGs')
    ap.add_argument('--rom', default=RC.JP_ROM if ET.IN_PROJECT else None, help='your original Japanese ROM (.z64, .v64 or .n64)')
    ap.add_argument('--out', default=os.path.join(ROOT, 'temp', 'rom_export', 'Eltale_textures_mod.z64') if ET.IN_PROJECT else 'my_mod.z64',
                    help='the new ROM to write (default: my_mod.z64)')
    ap.add_argument('--strict', action='store_true', help='stop instead of snapping a colour that is not in the palette')
    ap.add_argument('--all-copies', action='store_true', help='also write the edit to identical art elsewhere in the ROM')
    a = ap.parse_args()
    if not a.rom:
        raise SystemExit('Give the path to your original Japanese ROM:  python import_textures.py my_folder --rom "my rom.z64" --out my_mod.z64')
    src = ET.load_rom(a.rom)
    if ET.identify(src) != 'jp':
        raise SystemExit(ET.not_original(a.rom, src))
    if os.path.exists(a.out) and os.path.samefile(a.out, a.rom):       # also catches another spelling of the same file
        raise SystemExit('--out is the input ROM. The original is never overwritten. Nothing was written.')
    if not os.path.isdir(a.folder):
        raise SystemExit('%s is not a folder. Nothing was written.' % a.folder)
    rom, lines = Importer(src, a.strict, a.all_copies).run(a.folder)
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, 'wb') as f:
        f.write(rom)
    with open(a.out + '.report.txt', 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines) + '\n')
    print('\n'.join(lines))
    print('\n-> %s' % a.out)


if __name__ == '__main__':
    main()
