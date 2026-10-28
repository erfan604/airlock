#!/usr/bin/env bash
# AIR-279: turn a raw 16:9 screen recording into a 1920x1080, 30 fps mp4 without changing how fast it plays.
# Usage: scripts/video-normalize.sh <raw.mov>
# Writes ${VIDEO_NORM_DIR:-video/norm}/<name>.mp4 (created if missing); <name> is the raw file's name without its extension.
# Exit 0: written, and the output path is printed. Exit 1: the raw aspect ratio is outside 1.76 to 1.80 (the line "not 16:9"
# on stderr, nothing written). Exit 2: usage error or a file with no readable video stream. Exit 3: the output folder could
# not be created or ffmpeg failed (no partial file is left behind).
# The filter chain is scale, pad and fps only. Scale and pad keep the whole picture (letterbox, never a crop); fps turns a
# variable frame rate recording into a constant one. A take is never sped up or slowed down, so no filter here touches time.
# libx264 with yuv420p is explicit so the result plays in Remotion's OffthreadVideo whatever the recorder wrote. A Retina
# capture (for example 2880x1620) is 16:9 and passes; a 3024x1964 MacBook screen (1.54) does not.
set -euo pipefail

die() { echo "video-normalize: $2" >&2; exit "$1"; }

[ "$#" -eq 1 ] || die 2 "usage: scripts/video-normalize.sh <raw.mov>"
in="$1"
[ -f "$in" ] || die 2 "no such file: $in"
command -v ffmpeg >/dev/null 2>&1 && command -v ffprobe >/dev/null 2>&1 || die 2 "ffmpeg and ffprobe are required"

# width,height of the first video stream; an unreadable file or one with no video leaves $dims empty
dims=$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of default=nw=1:nk=1 -i "$in" 2>/dev/null | paste -sd, -) || dims=""
case "$dims" in
  [0-9]*,[0-9]*) ;;
  *) die 2 "no readable video stream in $in" ;;
esac
w=${dims%%,*}
h=${dims#*,}
case "$w$h" in *[!0-9]*) die 2 "unexpected size '$dims' in $in" ;; esac
[ "$w" -gt 0 ] && [ "$h" -gt 0 ] || die 2 "zero size '$dims' in $in"

# the gate is strict: 1.76 < width / height < 1.80
if ! awk -v w="$w" -v h="$h" 'BEGIN { r = w / h; exit !(r > 1.76 && r < 1.80) }'; then
  echo "not 16:9" >&2
  echo "video-normalize: $in is ${w}x${h} (ratio $(awk -v w="$w" -v h="$h" 'BEGIN { printf "%.3f", w / h }')), allowed 1.76 to 1.80" >&2
  exit 1
fi

base=$(basename -- "$in")
name=${base%.*}
[ -n "$name" ] || die 2 "cannot make an output name from $in"
out_dir="${VIDEO_NORM_DIR:-video/norm}"
mkdir -p "$out_dir" || die 3 "cannot create $out_dir"
out="$out_dir/$name.mp4"
[ ! "$in" -ef "$out" ] || die 2 "the input is the output file: $in"

# encode to a hidden partial file and rename on success, so a failed or interrupted run never leaves a half-written
# <name>.mp4 (a hidden name also stays out of a video/norm/*.mp4 glob)
tmp="$out_dir/.$name.partial.mp4"
trap 'rm -f "$tmp"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if ffmpeg -nostdin -hide_banner -loglevel error -y -i "$in" \
     -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=30" \
     -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p "$tmp"; then
  mv -f "$tmp" "$out"
else
  die 3 "ffmpeg failed on $in"
fi
echo "$out"
