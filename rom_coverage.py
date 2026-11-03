"""rom_coverage.py (2026-10-29): what the Japanese ROM holds, by block: the identified blocks, the gaps between them,
and (with --docs) every ROM range written anywhere in analysis/*.md, as a cross-check.

    python -I analysis/scripts/rom_coverage.py [--docs | --entries]

BLOCKS is the starting list for the ROM inventory pass (ROM_MAP.md section 6): add a row whenever a block is
identified, with where its bounds come from. GAPS_QUEST says what Quest 64 has at the same place (a guess until a
row in BLOCKS replaces it). Offsets are into the 16 MB .z64 of the JAPANESE ROM; our area past 0xF74890 was all
0xFF there.
"""
import glob, io, os, re, struct, sys

ROM_SIZE = 0x1000000

# (start, end, what, where the bounds come from)
BLOCKS = [
    (0x0000000, 0x0001000, 'header + boot code', 'N64 format'),
    (0x0001000, 0x0070550, 'main segment: code 0x1000-0x4C7B0, then .data / .rodata (as the EM fork splits them)',
     'eltail.jp.yaml (RAM = ROM + 0x7FFFF400)'),
    (0x0070550, 0x0071920, "the main segment's tail: libultra .rodata (D_8006F950 first, osSetIntMask's table), "
     'then the RSP ucode data: F3DEX 1.23 at 0x70E60 (D_80070260), audio at 0x71660 (D_80070A60)',
     'boot entry func_80000400 clears .bss from 0x80070D20, so this is copied data; the EM fork still models its '
     'RAM 0x8006F950-0x80070D20 as .bss (main_bss)'),
    # 2026-10-29 inventory pass: every block below with a func_8000D6A0 / func_80009764 / ... source was a gap before
    (0x0071920, 0x00753F0, 'segment 1: shared display lists + textures (the sky shapes too), loaded once at boot to '
     'RAM 0x80095AF0', 'func_80001084 (1870.c), gSPSegment 1 = D_8007A1D8; Quest: the bin after ucode_data'),
    (0x00753F0, 0x00851F0, 'gameplay common block, RAM 0x80100000 (the Pak menu module shares this RAM)',
     'func_8000D6A0 (map loader), only when the previous map is -1 (entering play); Quest maps/data_common'),
    (0x00851F0, 0x00C8DE0, 'interiors common block, RAM 0x8010FE00 (the interior maps load after it, at 0x801539F0)',
     'func_8000D6A0 when sMapData.unk0 & 2 (maps 13-25: buildings, castles, the monastery)'),
    (0x00C8DE0, 0x00EF280, '6 region blocks (one per region 0-5), RAM 0x801F8000',
     'table D_80057540 (ROM 0x58140, start/end/RAM), index sMapData.unk3C; outdoor maps 0-12 and interiors 13-25'),
    (0x00EF280, 0x03E1090, 'map blobs 0-12 (outdoors: town streets and fields): rooms, doors, cameras, NPC lists, '
     'collision, models, textures',
     'map table ROM 0x577B0, 36 x 0x44, +4/+8 ROM start/end (text_engine/NOTES.md section 9)'),
    (0x03E1090, 0x03F1BA0, 'shared field block for maps 3 / 5 / 7 / 12 (Dondoran Flats, West Carmagh, East Limelin, '
     'Skye), RAM 0x801E0000; no map owns it', 'func_8000D6A0 (map number 3, 5, 7 or 12)'),
    (0x03F1BA0, 0x0869620, 'map blobs 13-35 (interiors 13-25, then forests and dungeons 26-35)',
     'map table ROM 0x577B0'),
    (0x0869620, 0x086F6F0, "Brian's model, RAM 0x80206000", 'func_80003350 (3F50.c); Quest player/actor_Brian'),
    (0x086F6F0, 0x0871D10, 'NPC held objects, RAM 0x8020C0D0 (the overlay slot)',
     'func_80009764 (9D50.c) with every NPC area; Quest npcs/npc_held_objects (same size, 0x2620)'),
    (0x0871D10, 0x0A70350, '7 NPC model blobs (models + their name pools), RAM 0x8020E6F0',
     'table ROM 0x57480 = D_80056880 (7 start/end pairs; text_engine/NOTES.md), func_80009764'),
    (0x0A70350, 0x0A77F10, "Shannon's actor, RAM 0x802A0000",
     'func_80009764 with every NPC area; Quest npcs/actor_Shannon (same size, 0x7BC0)'),
    (0x0A77F10, 0x0CC2280, "6 monster sets (Holy Plains, Dondoran, Blue Cave, Desert, Normoon, Mammon in Quest's "
     'names), RAM 0x8020E6F0; picked per submap (unk84f1cs.unk12)',
     'table D_800561A0 (ROM 0x56DA0, 5 words: start, end, 3 RAM pointers into the set), func_8000A5E4; '
     'Quest monsters/*'),
    (0x0CC2280, 0x0D2E2F0, '8 boss files (Nepty, Solvaring, Zelse, Shilf, Fargo, Guilty, Mammon, Beigis in ROM '
     'order), RAM 0x802A7BC0', 'table D_803AB390 in the cutscene bank (ROM 0xD850A0, start/end by boss number), '
     'func_8000CEF0; Quest bosses/*'),
    (0x0D2E2F0, 0x0D384B0, 'dialogue + sign bank (JP; ours is relocated to 0xFC0000)', 'ROM_MAP.md section 2'),
    (0x0D384B0, 0x0D388B0, 'item icon palettes (colour + grey, 256 RGBA5551 each), RAM 0x803AC460',
     'func_80024F20 (216E0.c); ITEM_MENU_RESEARCH.md; Quest inventory/inventory_pal'),
    (0x0D388B0, 0x0D3A8B0, '32 item icon slots, 16x16 CI8 (0x100 each)', 'ITEM_MENU_RESEARCH.md; Quest inventory/icon_*'),
    (0x0D3A8B0, 0x0D3A930, 'text palettes (0x80), RAM 0x80332D30', 'func_80035308 (35EC0.c); Quest text/text_palettes'),
    (0x0D3A930, 0x0D490C0, 'font sheet (palette at 0xD3A8B0)', 'DMA log (text_engine/NOTES.md)'),
    (0x0D490C0, 0x0D74AC0, 'spell bank, loaded once to RAM 0x800C0000', 'SPELLS.md section 1'),
    (0x0D74AC0, 0x0D86170, 'cutscene bank (resident at RAM 0x8039ADB0; holds our code block since 2026-10-22)',
     'ROM_MAP.md sections 3-4'),
    (0x0D86170, 0x0D86770, 'sky palettes (3 x 256 colours), RAM D_800814B0',
     'func_8000D6A0 on entering play; SkyPaletteKey.palette indexes it (E2A0.c)'),
    (0x0D86770, 0x0D86970, 'the rotating palette (0x200 B; 202 colours turn), RAM D_80081AB0',
     'func_8000D6A0 on entering play; func_80010768 rotates it'),
    (0x0D86970, 0x0DA4570, '8 sky records: 0x800 B of palettes (to D_800808B0) + the sky texture (to D_8007C6B0), '
     '0x3400-0x4800 B each', 'table D_80060C48 (ROM 0x61848: ROM start, segment-1 display list), '
     'MapLight.unk1C, func_8000D6A0'),
    (0x0DA4570, 0x0DAB5F0, 'Controller Pak menu module, RAM 0x80100000', 'func_80000C70 (1870.c); rom_ledger.py'),
    (0x0DAB5F0, 0x0DC62B0, 'title overlay (game mode 3, RAM 0x8020C0D0)', 'func_800361B0'),
    (0x0DC62B0, 0x0E22690, 'intro overlay (mode 4, RAM 0x8020C0D0; backstory pages 0xE08438-0xE13430)',
     'func_800361E8'),
    (0x0E22690, 0x0E420D0, 'credits overlay (mode 5)', 'func_80036220'),
    (0x0E420D0, 0x0E43780, 'event blob A (scripted scenes, RAM 0x801C0000)', 'func_8000205C'),
    (0x0E43780, 0x0E5BF60, 'event blob B', 'func_800023F4'),
    (0x0E5BF60, 0x0E5ED70, 'instrument bank .ctl (B1 header), RAM 0x8037B780',
     'func_80000C70 -> func_80028FFC (1870.c); Quest Instrument_ctl (same size, 0x2E10)'),
    (0x0E5ED70, 0x0E98330, 'instrument bank .tbl (samples, streamed)', 'func_80028FFC; Quest Instrument_tbl'),
    (0x0E98330, 0x0ECB7B0, 'sequence bank (S1 header, 44 songs; last ends 0xECB7AD), songs to RAM 0x80368A00',
     'func_80028FFC'),
    (0x0ECB7B0, 0x0ECD470, 'sound-effect bank .ctl, RAM 0x8037E590',
     'func_80000C70 -> func_80029374; Quest SE_ctl (same size, 0x1CC0)'),
    (0x0ECD470, 0x0EF21A0, 'sound-effect bank .tbl (samples, streamed; zero pad from 0xEF2190)',
     'func_80029374; Quest SE_tbl; ends where the next table starts'),
    (0x0EF21A0, 0x0F2FB70, "Brian's 30 animations, one at a time to RAM 0x80200000",
     'table D_80055F98 (ROM 0x56B98, start/end by animation ID), func_80007A38 (3F50.c)'),
    (0x0F2FB70, 0x0F729B0, 'the six region map images (Map page, 244 x 185 CI8 + palette each)',
     'image table D_800614E4 (ROM 0x620E4); MAP_IMAGES.md'),
    (0x0F729B0, 0x0F74890, 'the four Map page cards of the JP release (entries 6-9 of the same table; ours are '
     'at 0xF74890 since 2026-10-20)', 'image table D_800614E4, func_8002C598; MAP_IMAGES.md'),
    (0x0F74890, 0x1000000, 'all 0xFF in the JP ROM (our area since 2026-10-20)', 'ROM_MAP.md section 0'),
]

# what Quest 64 (US, quest64.us.yaml) keeps at the same place as a gap; unverified for Eltale. Empty since the
# 2026-10-29 inventory pass identified every gap (Quest's names are in the rows' sources above).
GAPS_QUEST = {}


def gaps():
    out, prev = [], 0
    for a, b, _, _ in sorted(BLOCKS):
        if a > prev:
            out.append((prev, a))
        prev = max(prev, b)
    if prev < ROM_SIZE:
        out.append((prev, ROM_SIZE))
    return out


def doc_ranges():
    """Every `0xA-0xB` ROM range in analysis/*.md (both ends under 16 MB, not preceded by 'RAM'), merged."""
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.normpath(os.path.join(here, '..'))
    pat = re.compile(r'`?0x([0-9A-Fa-f]{4,7})`?\s*(?:-|–|\.\.)\s*`?(?:0x)?([0-9A-Fa-f]{4,7})`?')
    rng = []
    for f in glob.glob(os.path.join(root, '*.md')) + glob.glob(os.path.join(root, '*', '*.md')):
        t = io.open(f, encoding='utf-8', errors='replace').read()
        for m in pat.finditer(t):
            a, b = int(m.group(1), 16), int(m.group(2), 16)
            ctx = t[max(0, m.start() - 25):m.start()].lower()
            if 0x1000 <= a < b <= ROM_SIZE and b - a < 0x800000 and not ('ram' in ctx and 'rom' not in ctx):
                if (a, b) != (0x1000, 0x101000):   # the boot CRC's span, not a block
                    rng.append((a, b))
    merged = []
    for a, b in sorted(rng):
        if merged and a <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])
    return len(rng), merged


# ---- per-entry splits of the table-driven blocks (2026-10-29): bounds read from the JP ROM's own tables ----
JP_ROM = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '_source',
                                       'Eltale Monsters (Japan)-Orig.z64'))
# map number -> place, for comments only (MENU_PAGES.md "Map page" walk, text_engine/npc_atlas.py MAPS, the doors'
# destinations; 12 / 25 / 26 / 35 from play, 2026-10-29, which the doors confirm)
MAP_NAMES = ['Melrode', 'Dondoran', 'Holy Plains', 'Dondoran Flats', 'Larapool', 'West Carmagh', 'Normoon',
             'East Limelin', 'Limelin', 'Dindom Dries', 'Shamwood', 'Baragoon Moor',
             "Isle of Skye (doors to the Pirate Ship 25/0 and Nepty's lair 35/0)",
             'Melrode Monastery', 'Dondoran Castle', 'Melrode buildings', 'Dondoran buildings', 'Larapool inn',
             'West Carmagh buildings', 'rooms off Normoon (every exit leads to map 6)', 'Normoon buildings',
             'Limelin Castle', 'Limelin buildings', 'Highland buildings', 'Shamwood (Lavaar)',
             'ship and cabin rooms: the Pirate Ship at Skye (0-1, save point), rooms off Skye (2-4), the ferry cabins '
             '(5, 8, 9), two rooms off the World of Mammon (6-7)',
             "Blue Cave (room 2 Crystal Valley, 3-4 Epona's Cottage; 4 warps to the Pirate Ship 25/1)",
             'Cull Hazard', 'Baragoon Tunnel (Shilf)', 'Boil Hole (Fargo)', 'Brannoch Castle', 'Connor Forest',
             'Glencoe Forest', 'Windward Forest', 'World of Mammon', "Nepty's lair (underwater; warp from the Isle of Skye)"]
BOSS_NAMES = ['solvaring', 'zelse', 'nepty', 'shilf', 'fargo', 'guilty', 'beigis', 'mammon']   # boss number (NOTES)
ITEM_NAMES = ['Spirit Light', 'Fresh Bread', 'Honey Bread', 'Healing Potion', "Dragon's Potion", 'Dew Drop',
              'Mint Leaves', "Hero's Drink", 'Silent Flute', "Celine's Bell", 'Replica', "Giant's Shoes",
              'Silver Amulet', 'Golden Amulet', 'White Wings', 'Yellow Wings', 'Blue Wings', 'Green Wings',
              'Red Wings', 'Black Wings', 'Earth Orb', 'Wind Jade', 'Water Jewel', 'Fire Ruby', 'Eletale Book',
              'Dark Gaol Key']   # item ID = icon slot (text_engine/check_release.py ITEMS)
MAP_IMAGE_NAMES = ['Holy Plains', 'Dondoran Flats', 'West Carmagh', 'East Limelin', 'Dindom Dries', 'Baragoon Moor']
QUEST_MONSTERS = ['HolyPlains', 'Dondoran', 'BlueCave', 'Desert', 'Normoon', 'Mammon']


def entries(rom=None):
    """{block start: [(start, end, segment name, note), ...]} for the blocks the game indexes through a table.
    Every list tiles its block exactly (asserted), in ROM order."""
    if rom is None:
        rom = open(JP_ROM, 'rb').read()
    w = lambda o: struct.unpack('>I', rom[o:o + 4])[0]
    rows = []                                           # (start, end, name, note)
    for i in range(36):                                 # map table ROM 0x577B0, 36 x 0x44, +4 start, +8 end
        o = 0x577B0 + i * 0x44
        rows.append((w(o + 4), w(o + 8), 'map_%02d' % i, MAP_NAMES[i]))
    for i in range(7):                                  # NPC blobs, ROM 0x57480 (D_80056880)
        rows.append((w(0x57480 + 8 * i), w(0x57484 + 8 * i), 'npc_blob_%d' % i, ''))
    for i in range(6):                                  # monster sets, ROM 0x56DA0 (D_800561A0), 0x14 each
        rows.append((w(0x56DA0 + 0x14 * i), w(0x56DA4 + 0x14 * i), 'monsters_%d' % i,
                     "Quest's %s" % QUEST_MONSTERS[i]))
    for i in range(8):                                  # boss files, ROM 0xD850A0 (D_803AB390), by boss number
        rows.append((w(0xD850A0 + 8 * i), w(0xD850A4 + 8 * i), 'boss_' + BOSS_NAMES[i], 'boss %d' % i))
    for i in range(32):                                 # item icons, 0x100 each, slot = item ID
        rows.append((0xD388B0 + 0x100 * i, 0xD389B0 + 0x100 * i, 'item_icon_%02d' % i,
                     ITEM_NAMES[i] if i < len(ITEM_NAMES) else 'no item'))
    sky = sorted(w(0x61848 + 8 * i) for i in range(8))  # sky records, ROM 0x61848 (D_80060C48): ROM start + a DL
    for i in range(8):
        k = [w(0x61848 + 8 * j) for j in range(8)].index(sky[i])
        rows.append((sky[i], sky[i + 1] if i < 7 else 0xDA4570, 'sky_%d' % k, ''))
    for i in range(6):                                  # region blocks, ROM 0x58140 (D_80057540), start/end/RAM
        rows.append((w(0x58140 + 12 * i), w(0x58144 + 12 * i), 'region_%d' % i, ''))
    for i in range(30):                                 # Brian's animations, ROM 0x56B98 (D_80055F98), by anim ID
        rows.append((w(0x56B98 + 8 * i), w(0x56B9C + 8 * i), 'brian_anim_%02d' % i, ''))
    for i in range(10):                                 # Map page images, ROM 0x620E4 (D_800614E4): RAM, start, end
        rows.append((w(0x620E8 + 12 * i), w(0x620EC + 12 * i),
                     'map_image_%d' % i if i < 6 else 'map_card_jp_%d' % i,
                     MAP_IMAGE_NAMES[i] if i < 6 else 'word card'))
    out = {}
    for a, b, what, _ in sorted(BLOCKS):
        inside = sorted(r for r in rows if a <= r[0] < b)
        if not inside:
            continue
        pos = a
        for s, e, name, _ in inside:
            assert s == pos and e > s, 'block 0x%X: %s at 0x%X, expected 0x%X' % (a, name, s, pos)
            pos = e
        assert pos == b, 'block 0x%X: entries end at 0x%X, not 0x%X' % (a, pos, b)
        out[a] = inside
    assert sum(len(v) for v in out.values()) == len(rows), 'an entry lies outside its block'
    return out


def main():
    if '--entries' in sys.argv:
        for a, lst in sorted(entries().items()):
            print('0x%07X: %d entries' % (a, len(lst)))
            for s, e, name, note in lst:
                print('  0x%07X-0x%07X %7d B  %-16s %s' % (s, e, e - s, name, note))
        return
    known = sum(b - a for a, b, _, _ in BLOCKS)
    print('Identified blocks: %d KB = %.1f%% of the ROM' % (known // 1024, 100.0 * known / ROM_SIZE))
    for a, b, what, src in sorted(BLOCKS):
        print('  0x%07X-0x%07X %6d KB  %s  [%s]' % (a, b, (b - a) // 1024, what, src))
    g = gaps()
    tot = sum(b - a for a, b in g)
    print('Unidentified: %d KB = %.1f%%' % (tot // 1024, 100.0 * tot / ROM_SIZE))
    for a, b in g:
        print('  0x%07X-0x%07X %6d KB  %s' % (a, b, (b - a) // 1024, GAPS_QUEST.get(a, '')))
    if '--docs' in sys.argv:
        n, merged = doc_ranges()
        cov = sum(b - a for a, b in merged)
        print('Docs cross-check: %d ranges, %d merged, %.1f%% of the ROM mentioned somewhere' % (n, len(merged), 100.0 * cov / ROM_SIZE))


if __name__ == '__main__':
    main()
