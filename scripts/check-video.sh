#!/usr/bin/env bash
# AIR-280: gate the finished cut of the demo video. Reads one cut's files and prints VIDEO OK <seconds>s <size> MB (exit 0), or
# one FAIL <rule>: <detail> line per broken rule and the last line VIDEO FAIL <k> failures (exit 1). Exit 2: a usage error or a
# missing tool. AIR-250 fixes the cut, never this checker.
# Usage: scripts/check-video.sh [--dir <d>] [--script-json <file>] [--script-doc <file>] [--kit <dir>]
#   --dir <d>          where final.mp4, contact.png, final.meta.json, x-limits.txt and MUSIC.txt are read (default video)
#   --script-json <f>  a file holding the output of `pnpm tsx scripts/video-script-check.ts --json`, used instead of running it
#   --script-doc <f>   the script, searched for VOICE lines (default docs/video-script.md)
#   --kit <dir>        the Remotion project whose src folder and render-final.sh the speed rule reads
#                      (default $AIRLOCK_RESEARCH/spikes/video-kit)
# Rules, each at most once (the failure count is the number of FAIL lines):
#   duration      135 to 150 s, both inclusive; a missing or unreadable final.mp4 fails here and skips the rules that read it
#   script-total  within 1 s of the `seconds` key of the script JSON
#   format        1920x1080 at 30/1
#   audio         VOICE lines in the script: an audio stream with a volumedetect mean from -30 to -10 dB and a max of at most -1 dB
#                 (neither silent nor clipped); no VOICE line: no audio stream, unless MUSIC.txt exists
#   size          at most X_MAX_MB of x-limits.txt, counted in units of 1,000,000 bytes (the stricter reading of MB)
#   x-seconds     at most X_MAX_SECONDS of x-limits.txt
#   contact       contact.png exists and is not empty
#   meta          final.meta.json holds scriptSha256 equal to the sha256 of the script JSON, so the cut is of the locked script
#   speed         none of the three speed words in <kit>/src or <kit>/render-final.sh; a kit with neither is a failure too
# The speed words are assembled from fragments below, so a grep of this file for them finds nothing (AIR-280 check 7).
LC_ALL=C; export LC_ALL
set -uo pipefail   # no -e: every rule runs, whatever an earlier one found

die() { echo "check-video: $1" >&2; exit 2; }

dir=video
sjson=""
sdoc=docs/video-script.md
kit="${AIRLOCK_RESEARCH:-$HOME/apps/airlock-research}/spikes/video-kit"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dir|--script-json|--script-doc|--kit)
      [ "$#" -ge 2 ] || die "$1 needs a value"
      case "$1" in --dir) dir="$2" ;; --script-json) sjson="$2" ;; --script-doc) sdoc="$2" ;; --kit) kit="$2" ;; esac
      shift 2 ;;
    *) die "usage: scripts/check-video.sh [--dir <d>] [--script-json <file>] [--script-doc <file>] [--kit <dir>]" ;;
  esac
done
for tool in ffmpeg ffprobe jq awk; do command -v "$tool" >/dev/null 2>&1 || die "$tool is required"; done

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)" || die "cannot make a temp folder"
trap 'rm -rf "$tmp"' EXIT

FAILS=0
flag() { echo "FAIL $1: $2"; FAILS=$((FAILS + 1)); }
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
# a whole number from a KEY=value file (the last line wins, as in AIR-280 check 6), or empty
limit() { awk -F= -v k="$1" '$1 == k { v = $2 } END { gsub(/[ \r]/, "", v); if (v ~ /^[0-9]+$/) print v }' "$2"; }

# the locked script: the file given, or the checker's own output (its exit code is not read: with --json the payload is
# printed even for a draft with findings, and AIR-250 hashes the same output)
if [ -z "$sjson" ]; then
  sjson="$tmp/script.json"
  (cd "$here/.." && pnpm tsx scripts/video-script-check.ts --json > "$sjson" 2>/dev/null) || true
fi
script_total=""; script_sha=""
if [ -s "$sjson" ]; then
  script_total="$(jq -r 'if (.seconds | type) == "number" then .seconds else empty end' "$sjson" 2>/dev/null)" || script_total=""
  [ -z "$script_total" ] || script_sha="$(sha256 "$sjson")"
fi

mp4="$dir/final.mp4"
dur=""
if [ ! -s "$mp4" ]; then
  flag duration "$mp4 not found"
else
  dur="$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$mp4" 2>/dev/null | head -1)"
  case "$dur" in ""|*[!0-9.]*) dur="" ;; esac
  [ -n "$dur" ] || flag duration "ffprobe cannot read a duration from $mp4"
fi

if [ -n "$dur" ]; then
  awk -v d="$dur" 'BEGIN { exit !(d >= 135 && d <= 150) }' || flag duration "$dur s, must be 135 to 150 s"

  if [ -z "$script_total" ]; then
    flag script-total "no readable seconds key in the script JSON ($sjson)"
  elif ! awk -v d="$dur" -v s="$script_total" 'BEGIN { x = d - s; if (x < 0) x = -x; exit !(x <= 1) }'; then
    flag script-total "the cut is $dur s, the script total is $script_total s, they must be within 1 s"
  fi

  fmt="$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate -of default=nw=1:nk=1 "$mp4" 2>/dev/null | paste -sd, -)"
  [ "$fmt" = "1920,1080,30/1" ] || flag format "width,height,frame rate are '$fmt', must be 1920,1080,30/1"

  has_audio=no
  ffprobe -v error -select_streams a -show_entries stream=codec_type -of default=nw=1:nk=1 "$mp4" 2>/dev/null | grep -qx audio && has_audio=yes
  if [ ! -f "$sdoc" ]; then
    flag audio "script $sdoc not found, so the voice decision is unknown"
  elif grep -q '^VOICE ' "$sdoc"; then
    if [ "$has_audio" = no ]; then
      flag audio "$sdoc has VOICE lines but $mp4 has no audio stream"
    else
      levels="$(ffmpeg -nostdin -hide_banner -i "$mp4" -map 0:a:0 -af volumedetect -f null - 2>&1)"
      mean="$(printf '%s\n' "$levels" | sed -n 's/.*mean_volume: \(-*[0-9.]*\) dB.*/\1/p' | head -1)"
      max="$(printf '%s\n' "$levels" | sed -n 's/.*max_volume: \(-*[0-9.]*\) dB.*/\1/p' | head -1)"
      if [ -z "$mean" ] || [ -z "$max" ]; then
        flag audio "volumedetect printed no mean and max level for $mp4"
      elif ! awk -v m="$mean" -v x="$max" 'BEGIN { exit !(m >= -30 && m <= -10 && x <= -1) }'; then
        flag audio "mean $mean dB, max $max dB: the mean must be from -30 to -10 dB and the max at most -1 dB"
      fi
    fi
  elif [ "$has_audio" = yes ] && [ ! -e "$dir/MUSIC.txt" ]; then
    flag audio "no VOICE line in $sdoc, but $mp4 has an audio stream and $dir/MUSIC.txt does not exist"
  fi

  limits="$dir/x-limits.txt"
  xs=""; xm=""
  if [ -f "$limits" ]; then xs="$(limit X_MAX_SECONDS "$limits")"; xm="$(limit X_MAX_MB "$limits")"; fi
  bytes="$(wc -c < "$mp4" | tr -d ' ')"
  if [ -z "$xm" ]; then
    flag size "X_MAX_MB is missing or not a whole number in $limits"
  elif awk -v b="$bytes" -v m="$xm" 'BEGIN { exit !(b > m * 1000000) }'; then
    flag size "$bytes bytes, the limit is $xm MB ($(( xm * 1000000 )) bytes)"
  fi
  if [ -z "$xs" ]; then
    flag x-seconds "X_MAX_SECONDS is missing or not a whole number in $limits"
  elif awk -v d="$dur" -v m="$xs" 'BEGIN { exit !(d > m) }'; then
    flag x-seconds "$dur s, the limit is $xs s"
  fi
fi

[ -s "$dir/contact.png" ] || flag contact "$dir/contact.png not found or empty"

meta="$dir/final.meta.json"
if [ ! -f "$meta" ]; then
  flag meta "$meta not found"
elif [ -z "$script_sha" ]; then
  flag meta "no readable script JSON ($sjson) to compare $meta with"
else
  have="$(jq -r '.scriptSha256 // empty' "$meta" 2>/dev/null)" || have=""
  if [ -z "$have" ]; then
    flag meta "$meta has no scriptSha256"
  elif [ "$have" != "$script_sha" ]; then
    flag meta "scriptSha256 $have in $meta is not the sha256 $script_sha of the script JSON: the cut is not of the locked script"
  fi
fi

pb=play; pb="${pb}backRate"; st=set; st="${st}pts"; at=a; at="${at}tempo"
if [ ! -d "$kit/src" ] || [ ! -s "$kit/render-final.sh" ]; then
  flag speed "$kit/src or $kit/render-final.sh is missing, so nothing was searched"
else
  hits="$(grep -rnE "$pb|$st|$at" "$kit/src" "$kit/render-final.sh" 2>/dev/null | cut -d: -f1,2 | head -3 | paste -sd' ' -)"
  [ -z "$hits" ] || flag speed "a speed word at $hits"
fi

if [ "$FAILS" -gt 0 ]; then
  echo "VIDEO FAIL $FAILS failures"
  exit 1
fi
echo "VIDEO OK $(awk -v d="$dur" 'BEGIN { printf "%d", d + 0.5 }')s $(awk -v b="$bytes" 'BEGIN { printf "%.1f", b / 1000000 }') MB"
