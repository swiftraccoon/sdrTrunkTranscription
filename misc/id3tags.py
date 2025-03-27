#!/usr/bin/env python3

# 03:29:04 swiftraccoon@linux sdrTrunkTranscription ±|main ✗|→ python id3tags.py ~/SDRTrunk/recordings/52198/20250228_234741North_Carolina_VIPER_Rutherford_T-SPDControl__TO_52198_FROM_2150757.mp3 
# Title: 52198"Trp G Dist 2"
# Artist: 2150757
# Album: T-SPDControl
# Composer: sdrtrunk v0.6.1
# Track: None
# Genre: Scanner Audio
# Date: 2025
# Comment: Date:2025-02-28 23:47:41.124;System:North Carolina VIPER;Site:Rutherford;Name:T-SPDControl;Decoder:P25 Phase 1;Channel:0-221;Frequency:852387500;


import argparse
from dataclasses import dataclass
from typing import Optional
from mutagen.id3 import ID3, ID3NoHeaderError

@dataclass
class ID3Tags:
    title: Optional[str] = None; artist: Optional[str] = None; album: Optional[str] = None
    composer: Optional[str] = None; track: Optional[str] = None; genre: Optional[str] = None
    date: Optional[str] = None; comment: Optional[str] = None

def read_id3_tags(path: str) -> ID3Tags:
    try: t = ID3(path)
    except ID3NoHeaderError: raise Exception("No ID3 tag header found.")
    except Exception as e: raise Exception(f"Error reading ID3 tags: {e}")
    # Extract comment (look for 'eng' language + empty description first)
    c = next((cm.text[0] for cm in t.getall("COMM") 
              if cm.lang.lower() == "eng" and not (cm.desc or "").strip()), None)
    c = c or (t.getall("COMM")[0].text[0] if t.getall("COMM") and t.getall("COMM")[0].text else None)
    # Gather frames (TIT2,TPE1,TALB,TCOM,TRCK,TCON,TDRC) in correct order, then append comment
    f = [x.text[0] if x else None for x in (t.get(i) for i in ("TIT2","TPE1","TALB","TCOM","TRCK","TCON","TDRC"))]
    return ID3Tags(*f, c)

def main():
    p = argparse.ArgumentParser(description="Extract ID3 tags from an MP3 file.")
    p.add_argument("filepath", help="Path to the MP3 file")
    args = p.parse_args()
    try:
        tags = read_id3_tags(args.filepath)
        for k, v in tags.__dict__.items():
            print(f"{k.capitalize()}: {v}")
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    main()
