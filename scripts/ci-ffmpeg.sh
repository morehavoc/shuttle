#!/bin/sh
# Installs ffmpeg on a GitHub Actions Ubuntu runner for the tests (both workflows run this).
#
# On 2026-10-23 this install hung three times in an hour, 15 to 18 minutes each with no output at
# all, where it normally takes 25 s to 2 min. All three were runners in Azure's westus3 region;
# the runs that passed meanwhile were in eastus, eastus2 and northcentralus. So every apt call
# here has a time limit, and after a failed attempt apt switches from the Azure mirror the runner
# image points at to Canonical's own servers and refreshes only the Ubuntu package lists. The
# packages are signed by Ubuntu either way: the mirror changes speed, not trust. Each attempt says
# how long it took and which part gave up.
set -u
if command -v ffmpeg >/dev/null 2>&1 && ffmpeg -hide_banner -encoders 2>/dev/null | grep -q libx264; then
  echo "ffmpeg already installed: $(ffmpeg -version | head -1)"
  exit 0
fi
# man-db re-indexes the manual pages after every install, which can take minutes on these runners.
sudo rm -f /var/lib/man-db/auto-update

APT="-o Acquire::Retries=3 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20"
UPDATE_ONLY=""
use_canonical() {
  for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.sources /etc/apt/sources.list.d/*.list; do
    [ -f "$f" ] && sudo sed -i 's#://azure\.archive\.ubuntu\.com/ubuntu#://archive.ubuntu.com/ubuntu#g' "$f"
  done
  # Refresh only the Ubuntu lists, so a stalled third-party repo on the image can't hold it up.
  only=$(mktemp -d)
  for f in /etc/apt/sources.list.d/*; do
    [ -f "$f" ] && grep -q 'ubuntu\.com/ubuntu' "$f" && cp "$f" "$only/"
  done
  UPDATE_ONLY="-o Dir::Etc::SourceParts=$only -o APT::Get::List-Cleanup=0"
  echo "apt now uses: $(cat /etc/apt/sources.list "$only"/* 2>/dev/null | grep -oE 'https?://[^ ]+' | sort -u | tr '\n' ' ')"
}

for i in 1 2 3; do
  t0=$(date +%s)
  if ! sudo timeout -k 10 60 apt-get $APT $UPDATE_ONLY update -qq; then
    echo "::warning::ffmpeg install, attempt $i: apt-get update failed or ran past 60 s ($(( $(date +%s) - t0 )) s)"
  elif ! sudo env DEBIAN_FRONTEND=noninteractive timeout -k 10 180 apt-get $APT install -y -qq --no-install-recommends ffmpeg >/dev/null; then
    echo "::warning::ffmpeg install, attempt $i: apt-get install failed or ran past 180 s ($(( $(date +%s) - t0 )) s)"
    # An install stopped part-way leaves dpkg half done; the next attempt needs it finished.
    sudo env DEBIAN_FRONTEND=noninteractive timeout -k 10 120 dpkg --configure -a || true
  else
    echo "ffmpeg installed on attempt $i in $(( $(date +%s) - t0 )) s: $(ffmpeg -version | head -1)"
    exit 0
  fi
  [ "$i" -lt 3 ] || break
  [ -z "$UPDATE_ONLY" ] && use_canonical
  sleep 5
done
echo "::error::ffmpeg could not be installed in 3 attempts (apt mirrors unreachable from this runner?). Re-run the job."
exit 1
