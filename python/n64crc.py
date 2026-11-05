"""N64 header checksum (CIC-6102/7101 seed), as computed by rn64crc / IPL3."""
import struct

def crc(rom):
    seed = 0xF8CA4DDC
    t1 = t2 = t3 = t4 = t5 = t6 = seed
    M = 0xFFFFFFFF
    words = struct.unpack('>%dI' % (0x100000 // 4), rom[0x1000:0x101000])
    for d in words:
        if (t6 + d) & M < t6: t4 = (t4 + 1) & M
        t6 = (t6 + d) & M
        t3 ^= d
        r = ((d << (d & 0x1F)) | (d >> (32 - (d & 0x1F)))) & M if d & 0x1F else d
        t5 = (t5 + r) & M
        t2 = t2 ^ r if t2 > d else t2 ^ t6 ^ d
        t1 = (t1 + (t5 ^ d)) & M
    return (t6 ^ t4 ^ t3) & M, (t5 ^ t2 ^ t1) & M

def fix(rom):
    """Return rom (bytearray) with header CRC updated."""
    c1, c2 = crc(rom)
    rom[0x10:0x18] = struct.pack('>II', c1, c2)
    return rom

if __name__ == '__main__':
    import sys
    r = open(sys.argv[1], 'rb').read()
    c1, c2 = crc(r); h1, h2 = struct.unpack('>II', r[0x10:0x18])
    print(f'computed {c1:08X} {c2:08X}  header {h1:08X} {h2:08X}  {"OK" if (c1, c2) == (h1, h2) else "MISMATCH"}')
