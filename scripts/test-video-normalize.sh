#!/usr/bin/env bash
# AIR-279: offline tests of scripts/video-normalize.sh on synthetic clips. Every clip is made with ffmpeg -f lavfi testsrc
# (1 to 2 seconds) in a mktemp -d folder at run time and removed on exit, so no binary is committed. Every run of the script
# either sets VIDEO_NORM_DIR or works inside the temp folder, so the repo is never written to. Runs under macOS /bin/bash 3.2.
#   1 a Retina size clip (2880x1620 at 60 fps) comes out 1920x1080 at 30/1, h264, yuv420p, and the output folder is created
#   2 a 4:3 clip exits 1 with the line "not 16:9" on stderr and writes no file; the gate is strict at 1.76 and 1.80
#   3 the output duration equals the input duration within 0.1 s (nothing was sped up or slowed down)
#   4 a clip that is already 1920x1080 at 30 fps keeps both, and without VIDEO_NORM_DIR the output lands in video/norm
# Last line: VIDEO NORMALIZE TESTS OK (4 of 4)
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NORM="$here/video-normalize.sh"
T=""
trap '[ -z "$T" ] || rm -rf "$T"' EXIT
fail() { echo "FAIL $1: $2"; exit 1; }

command -v ffmpeg >/dev/null 2>&1 && command -v ffprobe >/dev/null 2>&1 || fail setup "ffmpeg and ffprobe are required"
[ -x "$NORM" ] || fail setup "scripts/video-normalize.sh is missing or not executable"
T="$(mktemp -d)"

mkclip() {   # mkclip <file> <WxH> <fps> <seconds>: a small synthetic clip, encoded fast
  ffmpeg -nostdin -hide_banner -loglevel error -y -f lavfi -i "testsrc=size=$2:rate=$3:duration=$4" \
    -c:v libx264 -preset ultrafast -crf 35 -pix_fmt yuv420p "$1" || fail setup "ffmpeg could not generate $1"
}
probe() {    # probe <file>: width,height,r_frame_rate of the first video stream (the form of AIR-279 check 3)
  ffprobe -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate -of default=nw=1:nk=1 "$1" | paste -sd, -
}
codec() {    # codec <file>: codec and pixel format of the first video stream
  ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,pix_fmt -of default=nw=1:nk=1 "$1" | paste -sd, -
}
duration() { # duration <file>: container duration in seconds
  ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$1"
}
run() {      # run <clip> <output dir>: runs the script, sets RC and ERR (its stderr; its stdout is dropped)
  RC=0; ERR="$(VIDEO_NORM_DIR="$2" "$NORM" "$1" 2>&1 >/dev/null)" || RC=$?
}
files_in() { # files_in <dir>: number of files below it (0 for a missing folder)
  find "$1" -type f 2>/dev/null | wc -l | tr -d ' '
}
PASS=0
passed() { PASS=$((PASS + 1)); echo "ok $PASS: $1"; }

# 1 Retina capture size: 1920x1080 at 30/1, h264 yuv420p, output folder created (two levels deep, none existed)
mkclip "$T/retina.mov" 2880x1620 60 2
run "$T/retina.mov" "$T/out1/nested"
[ "$RC" -eq 0 ] || fail retina "exit $RC, want 0: $ERR"
[ -s "$T/out1/nested/retina.mp4" ] || fail retina "no retina.mp4 in the output folder"
[ "$(probe "$T/out1/nested/retina.mp4")" = "1920,1080,30/1" ] || fail retina "got $(probe "$T/out1/nested/retina.mp4"), want 1920,1080,30/1"
[ "$(codec "$T/out1/nested/retina.mp4")" = "h264,yuv420p" ] || fail retina "got $(codec "$T/out1/nested/retina.mp4"), want h264,yuv420p"
[ "$(files_in "$T/out1")" = 1 ] || fail retina "the output folder holds $(files_in "$T/out1") files, want only retina.mp4"
passed "2880x1620 at 60 fps gives 1920x1080 at 30/1 (h264, yuv420p)"

# 2 4:3 is refused with the line "not 16:9" and nothing is written; the gate is strict: 352x200 (1.76) and 360x200 (1.80)
# are out, a MacBook-shaped 756x490 (1.54, the ratio of a 3024x1964 screen) is out, 354x200 (1.77) and 358x200 (1.79) are in
mkclip "$T/four3.mov" 1280x960 30 2
run "$T/four3.mov" "$T/out2"
[ "$RC" -eq 1 ] || fail four-three "exit $RC, want 1: $ERR"
printf '%s\n' "$ERR" | grep -qx 'not 16:9' || fail four-three "stderr has no line 'not 16:9': $ERR"
[ "$(files_in "$T/out2")" = 0 ] || fail four-three "wrote $(files_in "$T/out2") file(s) for a 4:3 clip"
for size in 352x200 360x200 756x490; do
  mkclip "$T/edge.mov" "$size" 30 1
  run "$T/edge.mov" "$T/out2"
  [ "$RC" -eq 1 ] || fail ratio-gate "$size: exit $RC, want 1"
  printf '%s\n' "$ERR" | grep -qx 'not 16:9' || fail ratio-gate "$size: stderr has no line 'not 16:9': $ERR"
done
[ "$(files_in "$T/out2")" = 0 ] || fail ratio-gate "wrote $(files_in "$T/out2") file(s) for clips outside the gate"
for size in 354x200 358x200; do
  mkclip "$T/edge.mov" "$size" 30 1
  run "$T/edge.mov" "$T/out2b"
  [ "$RC" -eq 0 ] || fail ratio-gate "$size: exit $RC, want 0: $ERR"
  [ "$(probe "$T/out2b/edge.mp4")" = "1920,1080,30/1" ] || fail ratio-gate "$size: got $(probe "$T/out2b/edge.mp4"), want 1920,1080,30/1"
done
passed "a 4:3 clip exits 1 with 'not 16:9' and writes nothing; the gate is strict at 1.76 and 1.80"

# 3 duration: a 24 fps source (30 is not a multiple of it, so frames are repeated) keeps its length, within 0.1 s
mkclip "$T/slow24.mov" 1280x720 24 2
run "$T/slow24.mov" "$T/out3"
[ "$RC" -eq 0 ] || fail duration "exit $RC, want 0: $ERR"
din="$(duration "$T/slow24.mov")"; dout="$(duration "$T/out3/slow24.mp4")"
case "$din$dout" in *[!0-9.]*|"") fail duration "unreadable durations: in '$din' out '$dout'" ;; esac
awk -v a="$din" -v b="$dout" 'BEGIN { exit !(a > 1.9 && b > 1.9) }' || fail duration "a clip is not about 2 s long: in $din out $dout"
awk -v a="$din" -v b="$dout" 'BEGIN { d = a - b; if (d < 0) d = -d; exit !(d <= 0.1) }' || fail duration "input $din s, output $dout s"
passed "output duration $dout s matches input duration $din s"

# 4 already 1920x1080 at 30 fps: same size and rate; no VIDEO_NORM_DIR, run inside a temp folder, so video/norm is the default
mkclip "$T/native.mov" 1920x1080 30 2
mkdir "$T/cwd4"
RC=0; ERR="$(cd "$T/cwd4" && env -u VIDEO_NORM_DIR "$NORM" "$T/native.mov" 2>&1 >/dev/null)" || RC=$?
[ "$RC" -eq 0 ] || fail native "exit $RC, want 0: $ERR"
[ -s "$T/cwd4/video/norm/native.mp4" ] || fail native "no video/norm/native.mp4 under the working folder"
[ "$(probe "$T/cwd4/video/norm/native.mp4")" = "1920,1080,30/1" ] || fail native "got $(probe "$T/cwd4/video/norm/native.mp4"), want 1920,1080,30/1"
passed "a 1920x1080 30 fps clip keeps both; the default folder is video/norm"

[ "$PASS" -eq 4 ] || fail summary "$PASS tests passed, want 4"
echo "VIDEO NORMALIZE TESTS OK ($PASS of 4)"
