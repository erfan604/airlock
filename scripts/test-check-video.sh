#!/usr/bin/env bash
# AIR-280: offline tests of scripts/check-video.sh on synthetic clips. Every clip is made with ffmpeg -f lavfi in a mktemp -d
# folder at run time and removed on exit, so no binary is committed and the repo is never written to. One 140 second base clip
# is encoded once and the cases reuse it with stream copy (a new audio track, a shorter cut, padding bytes). Runs under macOS
# /bin/bash 3.2. Every case passes all five seams (--dir, --script-json, --script-doc, --kit) so the real video/ folder, the
# script checker and the real kit are never read.
# Cases 1 to 14 are the ones AIR-280 lists (twelve clips that must each fail with one named rule, two that must print VIDEO OK);
# 15 and up pin the thresholds, the defaults and the paths the first fourteen leave open (found by mutation: each rule, comparison,
# default and message of check-video.sh was changed in turn and a case was added for every change that survived). A failing case must print exactly one
# FAIL line (or exactly the rules named) and the last line VIDEO FAIL <k> failures; a stub checker that prints nothing makes every
# failing case print UNEXPECTED PASS and every passing case fail on the missing VIDEO OK. All cases run even after a failure.
# Last line: CHECK VIDEO TESTS OK (<n> of <n>)
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK="$here/check-video.sh"
WANT=31
T=""
trap '[ -z "$T" ] || rm -rf "$T"' EXIT
fail() { echo "FAIL $1: $2"; exit 1; }

command -v ffmpeg >/dev/null 2>&1 && command -v ffprobe >/dev/null 2>&1 || fail setup "ffmpeg and ffprobe are required"
command -v jq >/dev/null 2>&1 || fail setup "jq is required"
[ -x "$CHECK" ] || fail setup "scripts/check-video.sh is missing or not executable"
T="$(mktemp -d)"

ff() { ffmpeg -nostdin -hide_banner -loglevel error -y "$@" || fail setup "ffmpeg could not generate a clip"; }
mkvid() {    # mkvid <file> <WxH> <fps> <seconds>: a still colour clip, encoded fast (static content costs almost nothing)
  ff -f lavfi -i "color=c=0x203040:size=$2:rate=$3:duration=$4" -c:v libx264 -preset ultrafast -crf 35 -pix_fmt yuv420p "$1"
}
tone() {     # tone <file> <seconds> <mean dB> [spike]: a 440 Hz sine of that mean level (rms); the optional spike adds a 2 ms click per second
  local amp spk="${4:-0}"
  amp=$(awk -v db="$3" 'BEGIN { printf "%.6f", sqrt(2) * 10 ^ (db / 20) }')
  ff -f lavfi -i "aevalsrc=${amp}*sin(2*PI*440*t)+if(lt(mod(t\,1)\,0.002)\,${spk}\,0):s=48000:d=$2" -c:a aac -b:a 128k "$1"
}
tone_exact() { # tone_exact <file> <seconds> <mean dB> [peak]: like tone but lossless (alac), so volumedetect reads the level exactly;
               # the optional peak is one sample of that height at the start of every second (a 440 Hz sine is 0 there)
  local amp spk="${4:-0}"
  amp=$(awk -v db="$3" 'BEGIN { printf "%.6f", sqrt(2) * 10 ^ (db / 20) }')
  ff -f lavfi -i "aevalsrc=${amp}*sin(2*PI*440*t)+if(eq(mod(n\,48000)\,0)\,${spk}\,0):s=48000:d=$2" -c:a alac "$1"
}
mux() {      # mux <out> <video> <audio>: both streams copied, no re-encode
  ff -i "$2" -i "$3" -c copy -shortest "$1"
}
cut_to() {   # cut_to <out> <video> <seconds>: stream copy of the first <seconds>
  ff -t "$3" -i "$2" -c copy "$1"
}
size_of() { wc -c < "$1" | tr -d ' '; }
pad_to() {   # pad_to <mp4> <bytes>: append one free box so the file is exactly that long (a valid mp4, same streams)
  local n=$(( $2 - $(size_of "$1") ))
  [ "$n" -ge 8 ] || fail setup "cannot pad $1 to $2 bytes"
  printf "$(printf '\\%03o\\%03o\\%03o\\%03o' $(( (n >> 24) & 255 )) $(( (n >> 16) & 255 )) $(( (n >> 8) & 255 )) $(( n & 255 )))free" >> "$1"
  head -c $(( n - 8 )) /dev/zero >> "$1"
}
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }

# the inputs every case shares: one base clip, a contact sheet stand-in and a kit folder whose source holds no speed word
BASE="$T/base.mp4"; CONTACT="$T/contact.png"; KIT_OK="$T/kit-ok"
mkvid "$BASE" 1920x1080 30 140
ff -f lavfi -i "color=c=gray:size=64x64" -frames:v 1 "$CONTACT"
mkdir -p "$KIT_OK/src"
printf 'export const Final = () => null;\n' > "$KIT_OK/src/Final.tsx"
printf '#!/usr/bin/env bash\necho render\n' > "$KIT_OK/render-final.sh"
# the three speed words are assembled here too, so this file does not hold them either
W1="playback""Rate"; W2="set""pts"; W3="a""tempo"

KIT="$KIT_OK"
mkcase() {   # mkcase <name> <video> <voice|caps> <script seconds>: C is a case folder holding a clean set of inputs
  C="$T/$1"; mkdir -p "$C/d"
  cp "$2" "$C/d/final.mp4"; cp "$CONTACT" "$C/d/contact.png"
  printf 'X_MAX_SECONDS=150\nX_MAX_MB=512\n' > "$C/d/x-limits.txt"
  printf '{ "seconds": %s, "shots": [], "cues": [] }\n' "$4" > "$C/script.json"
  setmeta
  if [ "$3" = voice ]; then printf '# script\nSHOT S01 0:00-2:20 mode TITLE\nVOICE S01-1 A voiced line.\n' > "$C/doc.md"
  else printf '# script\nSHOT S01 0:00-2:20 mode TITLE\nCAP S01-1 0:00-0:03 A caption.\n' > "$C/doc.md"; fi
}
setmeta() {  # the meta file the render would write for the case's current script.json
  printf '{ "scriptSha256": "%s", "voiceSha256": null, "command": "render-final", "date": "2026-11-12T00:00:00Z" }\n' "$(sha "$C/script.json")" > "$C/d/final.meta.json"
}
run() {      # run: the checker on the current case C; sets RC and OUT (stdout and stderr together)
  RC=0; OUT="$("$CHECK" --dir "$C/d" --script-json "$C/script.json" --script-doc "$C/doc.md" --kit "$KIT" 2>&1)" || RC=$?
}

N=0; PASS=0; BAD=0
begin() { BAD=0; NAME="$1"; }
finish() {
  N=$((N + 1))
  if [ "$BAD" -eq 0 ]; then PASS=$((PASS + 1)); echo "ok $N: $NAME"; else echo "not ok $N: $NAME"; fi
}
problem() { echo "FAIL $NAME: $1"; BAD=1; }
expect_fail() {  # expect_fail <label> <rule>...: exit 1, exactly one FAIL line per rule named and no other, last line VIDEO FAIL <k> failures
  local label="$1" rule k=$(( $# - 1 )) lines
  shift
  if [ "$RC" -eq 0 ]; then echo "UNEXPECTED PASS $label"; BAD=1; return 0; fi
  [ "$RC" -eq 1 ] || { problem "$label: exit $RC, want 1: $OUT"; return 0; }
  for rule in "$@"; do
    grep -qE "^FAIL $rule: ." <<<"$OUT" || problem "$label: no 'FAIL $rule: <detail>' line: $OUT"
  done
  lines=$(grep -c '^FAIL ' <<<"$OUT" || true)
  [ "$lines" -eq "$k" ] || problem "$label: $lines FAIL lines, want $k ($*): $OUT"
  [ "$(tail -1 <<<"$OUT")" = "VIDEO FAIL $k failures" ] || problem "$label: last line is '$(tail -1 <<<"$OUT")', want 'VIDEO FAIL $k failures'"
  return 0
}
expect_ok() {    # expect_ok <label> <seconds> <file>: exit 0, no FAIL line, the last line is VIDEO OK <seconds>s <size of the file> MB
  local want
  want="VIDEO OK $2s $(awk -v b="$(size_of "$3")" 'BEGIN { printf "%.1f", b / 1000000 }') MB"
  [ "$RC" -eq 0 ] || { problem "$1: exit $RC, want 0: $OUT"; return 0; }
  [ "$(tail -1 <<<"$OUT")" = "$want" ] || problem "$1: last line is '$(tail -1 <<<"$OUT")', want '$want'"
  if grep -q '^FAIL ' <<<"$OUT"; then problem "$1: FAIL lines in a passing run: $OUT"; fi
  return 0
}

expect_text() {  # expect_text <label> <regex>: some line of the last run matches (the detail names the cause, not just the rule)
  grep -qE -- "$2" <<<"$OUT" || problem "$1: no output line matches '$2': $OUT"
  return 0
}

# 1 to 5: the duration, the two format faults and the two voice faults
begin "1 a 100 second cut fails duration"
cut_to "$T/c100.mp4" "$BASE" 100
mkcase d100 "$T/c100.mp4" caps 100; run; expect_fail "100 s" duration; finish

begin "2 a 1280x720 cut fails format"
mkvid "$T/v720.mp4" 1280x720 30 140
mkcase f720 "$T/v720.mp4" caps 140; run; expect_fail "1280x720" format; finish

begin "3 a 25 fps cut fails format"
mkvid "$T/v25.mp4" 1920x1080 25 140
mkcase f25 "$T/v25.mp4" caps 140; run; expect_fail "25 fps" format; finish

begin "4 a voice track at -50 dB fails audio"
tone "$T/t50.m4a" 140 -50; mux "$T/a50.mp4" "$BASE" "$T/t50.m4a"
mkcase a50 "$T/a50.mp4" voice 140; run; expect_fail "-50 dB" audio; finish

begin "5 a clipped voice track fails audio"
tone "$T/tclip.m4a" 140 -20 0.9; mux "$T/aclip.mp4" "$BASE" "$T/tclip.m4a"
mkcase aclip "$T/aclip.mp4" voice 140; run; expect_fail "clipped" audio; finish

# 6: a file over the limit (one byte over 1 MB, limit 1)
begin "6 a file over X_MAX_MB fails size"
cp "$BASE" "$T/big.mp4"; pad_to "$T/big.mp4" 1500000
mkcase big "$T/big.mp4" caps 140; printf 'X_MAX_SECONDS=150\nX_MAX_MB=1\n' > "$C/d/x-limits.txt"; run; expect_fail "1.5 MB" size; finish

# 7, 8: the contact sheet and the meta hash
begin "7 a missing contact sheet fails contact"
mkcase nocontact "$BASE" caps 140; rm "$C/d/contact.png"; run; expect_fail "no contact.png" contact; finish

begin "8 a meta hash that differs from the script fails meta"
mkcase badmeta "$BASE" caps 140
printf '{ "scriptSha256": "%s", "voiceSha256": null, "command": "render-final", "date": "2026-11-12T00:00:00Z" }\n' "$(printf 'another script' | shasum -a 256 | cut -d' ' -f1)" > "$C/d/final.meta.json"
run; expect_fail "wrong hash" meta; finish

# 9, 10: the script total and the X seconds
begin "9 a 140 second cut against a script total of 145 fails script-total"
mkcase total145 "$BASE" caps 145; run; expect_fail "140 vs 145" script-total; finish

begin "10 a 140 second cut against X_MAX_SECONDS=130 fails x-seconds"
mkcase xsec "$BASE" caps 140; printf 'X_MAX_SECONDS=130\nX_MAX_MB=512\n' > "$C/d/x-limits.txt"; run; expect_fail "130 s limit" x-seconds; finish

# 11: the speed words in the kit source
begin "11 a kit whose src holds a speed word fails speed"
mkdir -p "$T/kit-bad/src"; cp "$KIT_OK/render-final.sh" "$T/kit-bad/"
printf 'const x = { %s: 2 };\n' "$W1" > "$T/kit-bad/src/Final.tsx"
mkcase speed "$BASE" caps 140; KIT="$T/kit-bad"; run; KIT="$KIT_OK"; expect_fail "$W1 in src" speed; finish

# 12: captions only with an audio stream and no MUSIC.txt
begin "12 a captions only script with an audio stream and no MUSIC.txt fails audio"
tone "$T/t20.m4a" 140 -20; mux "$T/v20.mp4" "$BASE" "$T/t20.m4a"
mkcase capsaudio "$T/v20.mp4" caps 140; run; expect_fail "caps with audio" audio; finish

# 13, 14: the two clips that pass
begin "13 VOICE lines and a voice track at -20 dB print VIDEO OK"
mkcase okvoice "$T/v20.mp4" voice 140; run; expect_ok "voice -20 dB" 140 "$C/d/final.mp4"; finish

begin "14 a captions only cut with no audio stream prints VIDEO OK"
mkcase okcaps "$BASE" caps 140; run; expect_ok "captions only" 140 "$C/d/final.mp4"; finish

# 15 a missing final.mp4 fails (AIR-250 check 1 before any render), and the rules that need no video still run
begin "15 a missing or unreadable final.mp4 fails duration, and no VIDEO OK is printed"
mkcase nofinal "$BASE" caps 140; rm "$C/d/final.mp4"; run; expect_fail "no final.mp4" duration
mkcase garbage "$BASE" caps 140; printf 'this is not a video\n' > "$C/d/final.mp4"; run; expect_fail "final.mp4 is not a video" duration; expect_text "final.mp4 is not a video" 'cannot read a duration'
finish

# 16 the duration limits are inclusive: 134 and 151 seconds fail, 135 and 150 pass (the script total follows the clip)
begin "16 the duration limits are 135 and 150 seconds, both inclusive"
for s in 134 135 150 151; do
  if [ "$s" -lt 140 ]; then cut_to "$T/cut$s.mp4" "$BASE" "$s"; else mkvid "$T/cut$s.mp4" 1920x1080 30 "$s"; fi
  mkcase "len$s" "$T/cut$s.mp4" caps "$s"; printf 'X_MAX_SECONDS=200\nX_MAX_MB=512\n' > "$C/d/x-limits.txt"; run
  case "$s" in 134|151) expect_fail "$s s" duration ;; *) expect_ok "$s s" "$s" "$C/d/final.mp4" ;; esac
done
finish

# 17 the script total is matched within 1 second: 0.9 s apart passes, 1.1 s apart fails, in either direction
begin "17 the cut may differ from the script total by 1 second (inclusive), no more"
mkcase tot1 "$BASE" caps 140.9; run; expect_ok "140 vs 140.9" 140 "$C/d/final.mp4"
mkcase tot2 "$BASE" caps 139.1; run; expect_ok "140 vs 139.1" 140 "$C/d/final.mp4"
mkcase tot5 "$BASE" caps 141; run; expect_ok "140 vs 141" 140 "$C/d/final.mp4"
mkcase tot6 "$BASE" caps 139; run; expect_ok "140 vs 139" 140 "$C/d/final.mp4"
mkcase tot3 "$BASE" caps 141.1; run; expect_fail "140 vs 141.1" script-total
mkcase tot4 "$BASE" caps 138.9; run; expect_fail "140 vs 138.9" script-total
finish

# 18 the voice level limits: mean -30 to -10 dB, max at most -1 dB (a tone's peak is 3 dB above its mean)
begin "18 the voice must have a mean between -30 and -10 dB and a max of at most -1 dB"
for lv in -31 -29 -11 -9; do
  tone "$T/tl.m4a" 140 "$lv"; mux "$T/al.mp4" "$BASE" "$T/tl.m4a"
  mkcase "lv$lv" "$T/al.mp4" voice 140; run
  case "$lv" in -31|-9) expect_fail "mean $lv dB" audio ;; *) expect_ok "mean $lv dB" 140 "$C/d/final.mp4" ;; esac
done
tone "$T/tp2.m4a" 140 -20 0.65; mux "$T/ap2.mp4" "$BASE" "$T/tp2.m4a"
mkcase peak2 "$T/ap2.mp4" voice 140; run; expect_ok "peak about -2 dB" 140 "$C/d/final.mp4"
tone "$T/tp05.m4a" 140 -20 0.8; mux "$T/ap05.mp4" "$BASE" "$T/tp05.m4a"
mkcase peak05 "$T/ap05.mp4" voice 140; run; expect_fail "peak about -0.5 dB" audio
finish

# 19 VOICE lines need an audio stream (a captions only cut would silently drop the voice)
begin "19 VOICE lines and no audio stream fail audio"
mkcase voiceless "$BASE" voice 140; run; expect_fail "voice lines, no audio" audio; expect_text "voice lines, no audio" 'has no audio stream'
finish

# 20 MUSIC.txt allows the audio stream of a captions only cut
begin "20 a captions only cut with an audio stream passes when MUSIC.txt exists"
mkcase music "$T/v20.mp4" caps 140; printf 'a clearly licensed track\n' > "$C/d/MUSIC.txt"; run; expect_ok "MUSIC.txt" 140 "$C/d/final.mp4"; finish

# 21 each of the three speed words is found, in src (also in a nested folder) and in render-final.sh; a missing kit is a failure
begin "21 every speed word fails speed in src or render-final.sh, and a kit with nothing to search fails too"
mkcase spd "$BASE" caps 140
for w in "$W1" "$W2" "$W3"; do
  rm -rf "$T/kit-w"; mkdir -p "$T/kit-w/src/deep"; cp "$KIT_OK/render-final.sh" "$T/kit-w/"; cp "$KIT_OK/src/Final.tsx" "$T/kit-w/src/"
  printf '// %s\n' "$w" > "$T/kit-w/src/deep/Extra.tsx"
  KIT="$T/kit-w"; run; expect_fail "$w in src/deep" speed
  rm -rf "$T/kit-w/src/deep"; printf '# %s 2\n' "$w" >> "$T/kit-w/render-final.sh"
  run; expect_fail "$w in render-final.sh" speed
done
KIT="$T/kit-none"; run; expect_fail "no kit folder" speed
mkdir -p "$T/kit-nosh/src"; cp "$KIT_OK/src/Final.tsx" "$T/kit-nosh/src/"
KIT="$T/kit-nosh"; run; expect_fail "no render-final.sh" speed
mkdir -p "$T/kit-nosrc"; cp "$KIT_OK/render-final.sh" "$T/kit-nosrc/"
KIT="$T/kit-nosrc"; run; expect_fail "no src folder" speed
KIT="$KIT_OK"
finish

# 22 the size limit is decimal MB and inclusive: exactly 1,000,000 bytes passes at X_MAX_MB=1, one byte more fails; the limits file is required
begin "22 X_MAX_MB is a limit in 1,000,000 byte units, and x-limits.txt must give both numbers"
cp "$BASE" "$T/s1.mp4"; pad_to "$T/s1.mp4" 1000000
mkcase sz1 "$T/s1.mp4" caps 140; printf 'X_MAX_SECONDS=150\nX_MAX_MB=1\n' > "$C/d/x-limits.txt"; run; expect_ok "1000000 bytes" 140 "$C/d/final.mp4"
cp "$BASE" "$T/s2.mp4"; pad_to "$T/s2.mp4" 1000001
mkcase sz2 "$T/s2.mp4" caps 140; printf 'X_MAX_SECONDS=150\nX_MAX_MB=1\n' > "$C/d/x-limits.txt"; run; expect_fail "1000001 bytes" size
mkcase xl1 "$BASE" caps 140; rm "$C/d/x-limits.txt"; run; expect_fail "no x-limits.txt" size x-seconds
expect_text "no x-limits.txt" '^FAIL size: X_MAX_MB is missing'; expect_text "no x-limits.txt" '^FAIL x-seconds: X_MAX_SECONDS is missing'
mkcase xl2 "$BASE" caps 140; printf 'X_MAX_SECONDS=150\nX_MAX_MB=lots\n' > "$C/d/x-limits.txt"; run; expect_fail "X_MAX_MB not a number" size
expect_text "X_MAX_MB not a number" '^FAIL size: X_MAX_MB is missing or not a whole number'
mkcase xl3 "$BASE" caps 140; printf 'X_MAX_MB=512\n' > "$C/d/x-limits.txt"; run; expect_fail "no X_MAX_SECONDS" x-seconds
expect_text "no X_MAX_SECONDS" '^FAIL x-seconds: X_MAX_SECONDS is missing' 
finish

# 23 the X seconds limit is inclusive: a 140 second cut passes at X_MAX_SECONDS=140
begin "23 X_MAX_SECONDS is inclusive"
mkcase xs140 "$BASE" caps 140; printf 'X_MAX_SECONDS=140\nX_MAX_MB=512\n' > "$C/d/x-limits.txt"; run; expect_ok "140 s at limit 140" 140 "$C/d/final.mp4"
mkcase xs139 "$BASE" caps 140; printf 'X_MAX_SECONDS=139\nX_MAX_MB=512\n' > "$C/d/x-limits.txt"; run; expect_fail "140 s at limit 139" x-seconds
finish

# 24 the meta file: missing, without the hash key, and a script that changed after the render all fail meta; an unreadable
# script JSON fails script-total and meta; two broken rules print "VIDEO FAIL 2 failures"; an empty contact sheet fails contact
begin "24 meta, script JSON and contact sheet faults are named, and the failure count is the number of FAIL lines"
mkcase m1 "$BASE" caps 140; rm "$C/d/final.meta.json"; run; expect_fail "no meta file" meta; expect_text "no meta file" '^FAIL meta: .*final.meta.json not found'
mkcase m2 "$BASE" caps 140; printf '{ "voiceSha256": null }\n' > "$C/d/final.meta.json"; run; expect_fail "meta without scriptSha256" meta
expect_text "meta without scriptSha256" '^FAIL meta: .* has no scriptSha256'
mkcase m3 "$BASE" caps 140; printf '{ "seconds": 140, "shots": [ { "shot": "S01" } ], "cues": [] }\n' > "$C/script.json"; run; expect_fail "script changed after the render" meta
mkcase m4 "$BASE" caps 140; printf 'not json\n' > "$C/script.json"; setmeta; run; expect_fail "script JSON unreadable" script-total meta; expect_text "script JSON unreadable" '^FAIL meta: no readable script JSON'
mkcase m5 "$BASE" caps 140; : > "$C/d/contact.png"; run; expect_fail "empty contact.png" contact
mkcase m6 "$BASE" caps 140; rm "$C/d/contact.png" "$C/d/final.meta.json"; run; expect_fail "contact and meta" contact meta
finish

# 25 the exact edges of the voice limits, with a lossless track so the levels are exact: mean -30.0 and -10.0 dB and a max of
# -1.0 dB pass (the limits are inclusive), a max of -0.9 dB fails
begin "25 the voice limits are inclusive: mean -30.0 and -10.0 dB, max -1.0 dB"
for lv in -30 -10; do
  tone_exact "$T/te.m4a" 140 "$lv"; mux "$T/ae.mp4" "$BASE" "$T/te.m4a"
  mkcase "ex$lv" "$T/ae.mp4" voice 140; run; expect_ok "mean $lv.0 dB" 140 "$C/d/final.mp4"
done
tone_exact "$T/te1.m4a" 140 -20 0.891251; mux "$T/ae1.mp4" "$BASE" "$T/te1.m4a"
mkcase exmax1 "$T/ae1.mp4" voice 140; run; expect_ok "max -1.0 dB" 140 "$C/d/final.mp4"
tone_exact "$T/te2.m4a" 140 -20 0.9; mux "$T/ae2.mp4" "$BASE" "$T/te2.m4a"
mkcase exmax2 "$T/ae2.mp4" voice 140; run; expect_fail "max -0.9 dB" audio
finish

# 26 the defaults: video/ and docs/video-script.md under the working folder, and the kit under $AIRLOCK_RESEARCH or, without it,
# under $HOME/apps/airlock-research
begin "26 the defaults are video, docs/video-script.md and the kit under AIRLOCK_RESEARCH or HOME"
mkcase dflt "$T/v20.mp4" voice 140
mkdir -p "$C/docs" "$C/video" "$T/rs/spikes/video-kit/src" "$T/home/apps/airlock-research/spikes/video-kit/src"
cp "$C/d/"* "$C/video/"; cp "$C/doc.md" "$C/docs/video-script.md"
for k in "$T/rs" "$T/home/apps/airlock-research"; do
  cp "$KIT_OK/render-final.sh" "$k/spikes/video-kit/"; cp "$KIT_OK/src/Final.tsx" "$k/spikes/video-kit/src/"
done
RC=0; OUT="$(cd "$C" && env AIRLOCK_RESEARCH="$T/rs" "$CHECK" --script-json "$C/script.json" 2>&1)" || RC=$?
expect_ok "defaults with AIRLOCK_RESEARCH" 140 "$C/video/final.mp4"
RC=0; OUT="$(cd "$C" && env -u AIRLOCK_RESEARCH HOME="$T/home" "$CHECK" --script-json "$C/script.json" 2>&1)" || RC=$?
expect_ok "defaults with HOME" 140 "$C/video/final.mp4"
RC=0; OUT="$(cd "$C" && env AIRLOCK_RESEARCH="$T/rs-none" "$CHECK" --script-json "$C/script.json" 2>&1)" || RC=$?
expect_fail "AIRLOCK_RESEARCH without a kit" speed
finish

# 27 usage errors exit 2 and print no verdict
begin "27 an unknown flag and a flag without a value exit 2"
RC=0; OUT="$("$CHECK" --bogus 2>&1)" || RC=$?
{ [ "$RC" -eq 2 ] && grep -q 'usage' <<<"$OUT" && ! grep -q '^VIDEO ' <<<"$OUT"; } || problem "unknown flag: exit $RC: $OUT"
RC=0; OUT="$("$CHECK" --dir 2>&1)" || RC=$?
{ [ "$RC" -eq 2 ] && grep -q 'needs a value' <<<"$OUT" && ! grep -q '^VIDEO ' <<<"$OUT"; } || problem "--dir without a value: exit $RC: $OUT"
finish

# 28 the duration is printed rounded to a whole second: 140.4 s is 140s, 140.6 s is 141s
begin "28 the passing line rounds the duration to a whole second"
mkvid "$T/r404.mp4" 1920x1080 30 140.4; mkvid "$T/r406.mp4" 1920x1080 30 140.6
mkcase r404 "$T/r404.mp4" caps 140.4; run; expect_ok "140.4 s" 140 "$C/d/final.mp4"
mkcase r406 "$T/r406.mp4" caps 140.6; run; expect_ok "140.6 s" 141 "$C/d/final.mp4"
finish

# 29 the voice decision is read from the script: a missing script is a failure, and VOICE counts only at the start of a line
begin "29 a missing script doc fails audio, and VOICE inside a line is not a VOICE line"
mkcase nodoc "$BASE" caps 140; rm "$C/doc.md"; run; expect_fail "no script doc" audio; expect_text "no script doc" '^FAIL audio: script .* not found'
mkcase midline "$BASE" caps 140; printf '# script\nCAP S01-1 0:00-0:03 the VOICE line is a note\n  VOICE S01-1 indented\n' > "$C/doc.md"; run; expect_ok "VOICE inside a line" 140 "$C/d/final.mp4"
finish

# 30 x-limits.txt: the last line of a key wins (as in AIR-280 check 6), and a number must be whole
begin "30 x-limits.txt: the last value of a key wins, and a limit must be a whole number"
mkcase xl4 "$BASE" caps 140; printf 'X_MAX_SECONDS=100\nX_MAX_MB=512\nX_MAX_SECONDS=150\n' > "$C/d/x-limits.txt"; run; expect_ok "100 then 150" 140 "$C/d/final.mp4"
mkcase xl5 "$BASE" caps 140; printf 'X_MAX_SECONDS=150\nX_MAX_MB=512\nX_MAX_SECONDS=100\n' > "$C/d/x-limits.txt"; run; expect_fail "150 then 100" x-seconds
mkcase xl6 "$BASE" caps 140; printf 'X_MAX_SECONDS=150\nX_MAX_MB=1.5\n' > "$C/d/x-limits.txt"; run; expect_fail "X_MAX_MB=1.5" size; expect_text "X_MAX_MB=1.5" 'not a whole number'
finish

# 31 without --script-json the script is the output of `pnpm tsx scripts/video-script-check.ts --json` run in the repo that holds
# the checker, and the hash is taken of its bytes (a stub pnpm on PATH answers only to exactly those arguments)
begin "31 without --script-json the checker runs pnpm tsx scripts/video-script-check.ts --json"
mkdir -p "$T/bin" "$T/repo/scripts"; cp "$CHECK" "$T/repo/scripts/check-video.sh"
cat > "$T/bin/pnpm" <<'STUB'
#!/bin/sh
[ -z "${STUB_FAIL:-}" ] || exit 2
[ "$*" = "tsx scripts/video-script-check.ts --json" ] && [ "$(basename "$PWD")" = repo ] || exit 3
printf '{ "seconds": 140, "shots": [], "cues": [], "note": "from the stub" }\n'
STUB
chmod +x "$T/bin/pnpm"
mkcase stubok "$BASE" caps 140
(cd "$T/repo" && PATH="$T/bin:$PATH" "$T/bin/pnpm" tsx scripts/video-script-check.ts --json) > "$C/script.json"; setmeta
RC=0; OUT="$(cd "$C" && PATH="$T/bin:$PATH" "$T/repo/scripts/check-video.sh" --dir "$C/d" --script-doc "$C/doc.md" --kit "$KIT_OK" 2>&1)" || RC=$?
expect_ok "stub pnpm output" 140 "$C/d/final.mp4"
printf '{ "seconds": 140, "shots": [], "cues": [], "note": "changed" }\n' > "$C/script.json"; setmeta
RC=0; OUT="$(cd "$C" && PATH="$T/bin:$PATH" "$T/repo/scripts/check-video.sh" --dir "$C/d" --script-doc "$C/doc.md" --kit "$KIT_OK" 2>&1)" || RC=$?
expect_fail "meta of another script" meta
RC=0; OUT="$(cd "$C" && STUB_FAIL=1 PATH="$T/bin:$PATH" "$T/repo/scripts/check-video.sh" --dir "$C/d" --script-doc "$C/doc.md" --kit "$KIT_OK" 2>&1)" || RC=$?
expect_fail "pnpm fails" script-total meta
finish

[ "$N" -eq "$WANT" ] || { echo "FAIL summary: $N cases ran, the file says $WANT"; exit 1; }
if [ "$PASS" -ne "$WANT" ]; then echo "CHECK VIDEO TESTS FAILED ($PASS of $WANT passed)"; exit 1; fi
echo "CHECK VIDEO TESTS OK ($PASS of $WANT)"
