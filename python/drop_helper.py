"""Drag and drop on Windows: the two .bat files in the handed-out tool start this. export = a ROM was dropped; build = a folder of edited PNGs was dropped."""
import os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, 'reconfigure'):
        stream.reconfigure(errors='replace')                # a file name the console cannot show must not stop the tool

import export_textures as ET
import import_textures as IT

REMEMBER = os.path.join(HERE, 'last_rom.txt')
ROM_SIZE = 0x1000000
EXPORT_BAT, BUILD_BAT = 'Drop ROM here to export.bat', 'Drop folder here to build.bat'


def remember(path):
    try:
        with open(REMEMBER, 'w', encoding='utf-8') as f:
            f.write(os.path.abspath(path))
    except OSError:
        pass                                                # only a convenience: the build can still find or ask for the ROM


def is_original(path):
    try:
        if not os.path.isfile(path) or os.path.getsize(path) != ROM_SIZE:
            return False
        return ET.identify(ET.load_rom(path)) == 'jp'
    except (OSError, SystemExit):
        return False


def candidates(folder):
    """where the original ROM may be, most likely first: the one last used, then beside the edits folder, then inside it"""
    if os.path.exists(REMEMBER):
        try:
            with open(REMEMBER, encoding='utf-8') as f:
                yield f.read().strip()
        except OSError:
            pass
    for d in (os.path.dirname(folder), folder):
        try:
            names = sorted(os.listdir(d))
        except OSError:
            continue
        for n in names:
            if n.lower().endswith(('.z64', '.v64', '.n64')):
                yield os.path.join(d, n)


def find_rom(folder):
    for p in candidates(folder):
        if is_original(p):
            return p
    print('I could not find your original Japanese ROM.')
    for _ in range(3):
        try:
            p = input('Drag your ROM into this window and press Enter: ').strip().strip('"')
        except EOFError:
            break
        if is_original(p):
            return os.path.abspath(p)
        print('That is not the original Japanese ROM (see the hashes in README.md).')
    raise SystemExit('No original ROM, so nothing was written.')


def export(rom):
    if os.path.isdir(rom):
        raise SystemExit('That is a folder. Drop your ROM here. Edited folders go on "%s".' % BUILD_BAT)
    out = os.path.join(os.path.dirname(rom), 'exported_textures')
    if os.path.exists(os.path.join(out, 'manifest.csv')):
        raise SystemExit('"%s" already holds an export, so I left it alone in case you edited anything inside it. Rename or delete that folder to export again. '
                         'Nothing was written.' % out)
    sys.argv = ['export_textures.py', rom, '--out', out]
    ET.main()
    remember(rom)
    print('\nDone. Your textures are in:\n  %s' % out)
    print('\nCopy the ones you want to change into a folder of your own, and edit them there, keeping the same width and height.')
    print('Then drag that folder onto "%s".' % BUILD_BAT)


def build(folder):
    if not os.path.isdir(folder):
        raise SystemExit('That is a file. Drop the folder holding your edited PNGs here. Your ROM goes on "%s".' % EXPORT_BAT)
    folder = os.path.abspath(folder)
    rom = find_rom(folder)
    out = folder.rstrip('\\/') + '.z64'
    print('Using this ROM: %s\n' % rom)
    sys.argv = ['import_textures.py', folder, '--rom', rom, '--out', out]
    IT.main()
    remember(rom)
    print('\nDone. Load this in your emulator:\n  %s' % out)


def main():
    what, paths = sys.argv[1], sys.argv[2:]
    use = {'export': (export, 'your original ROM'), 'build': (build, 'the folder holding your edited PNGs')}[what]
    if len(paths) != 1:
        raise SystemExit('Drag %s onto this file, one at a time.' % use[1] if not paths else 'Please drop just one item: %s.' % use[1])
    try:
        use[0](os.path.abspath(paths[0]))
    except OSError as e:
        raise SystemExit('Could not write there: %s. Try moving it to a folder you can write to, such as Documents. Your ROM was not changed.' % (e.strerror or e))


if __name__ == '__main__':
    main()
