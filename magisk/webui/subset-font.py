import argparse
import hashlib
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont


def main():
    parser = argparse.ArgumentParser(description="Build the offline UI font from the pinned Noto CJK source.")
    parser.add_argument("source", type=Path)
    args = parser.parse_args()
    expected = "2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b"
    if hashlib.sha256(args.source.read_bytes()).hexdigest() != expected:
        parser.error("Source does not match FONT-LICENSE.txt")
    root = Path(__file__).resolve().parent
    characters = set(chr(codepoint) for codepoint in range(0x20, 0x100))
    for codepoint in range(0xB0A1, 0xD7FA):
        if codepoint & 0xFF >= 0xA1:
            try:
                characters.update(bytes((codepoint >> 8, codepoint & 0xFF)).decode("gb2312"))
            except UnicodeDecodeError:
                pass
    for directory in (root / "src", root.parent / "tests"):
        for filename in directory.rglob("*"):
            if filename.is_file() and filename.suffix in {".kt", ".html", ".js", ".cjs"}:
                characters.update(filename.read_text(encoding="utf-8"))
    characters.update("　、。〈〉《》「」『』【】〔〕〖〗〘〙〚〛〜〝〞〟〰〾〿–—‘’‛“”„‟…‧﹏，。！？；：（）")
    font = TTFont(args.source)
    options = subset.Options()
    options.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14]
    options.name_legacy = True
    options.name_languages = [0x409]
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(text="".join(sorted(characters)))
    subsetter.subset(font)
    names = {1: "Mihomo Offline UI", 3: "Mihomo Offline UI Regular", 4: "Mihomo Offline UI Regular", 6: "MihomoOfflineUI-Regular"}
    for record in font["name"].names:
        if record.nameID in names:
            record.string = names[record.nameID].encode(record.getEncoding())
    if "CFF " in font:
        cff = font["CFF "].cff
        cff.fontNames = ["MihomoOfflineUI-Regular"]
        cff.topDictIndex[0].FamilyName = "Mihomo Offline UI"
        cff.topDictIndex[0].FullName = "Mihomo Offline UI Regular"
    destination = root / "src/wasmJsMain/composeResources/font/noto_sans_sc.otf"
    font.save(destination)
    print(f"{len(font.getBestCmap())} characters; {destination.stat().st_size} bytes; {destination}")


if __name__ == "__main__":
    main()
