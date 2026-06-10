"""
Fresh-machine smoke test for lain on Modal — run it manually whenever you want
to verify the real `curl | bash` install works end to end on a clean box.

It does NOT run in CI (that would be wasteful + needs creds). Run it on demand:

    # binary install (the default; falls back to source if there's no release):
    LAIN_BEDROCK_TOKEN="$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.config/lain/credentials.json')))['bedrock']['apiKey'])")" \
      modal run scripts/modal_smoke.py

    # force the from-source path:
    LAIN_SMOKE_MODE=source LAIN_BEDROCK_TOKEN=... modal run scripts/modal_smoke.py

    # without a token: install + version/doctor/help/serve only (no generation):
    modal run scripts/modal_smoke.py

The install runs at image-build time (a faithful fresh-machine test with no
5-minute function cap), then a function exercises the installed `lain`: version,
doctor, help, a real Bedrock generation (if a token is provided), and the web
server's HTTP surface. Each run re-installs fresh (the install layer is
cache-busted by a timestamp); the apt layer stays cached.

Env:
  LAIN_SMOKE_MODE     "binary" (default) or "source"
  LAIN_BEDROCK_TOKEN  Bedrock bearer token (optional — enables the generation)
  LAIN_INSTALL_URL    installer URL (default: the GitHub Pages one-liner)
"""
import os
import subprocess
import sys
import time

import modal

MODE = os.environ.get("LAIN_SMOKE_MODE", "binary")
INSTALL_URL = os.environ.get("LAIN_INSTALL_URL", "https://tetraslam.github.io/lain/install")
FROM_SOURCE = "LAIN_FROM_SOURCE=1 " if MODE == "source" else ""

app = modal.App("lain-smoke")

# A minimal "fresh machine": debian + just enough to run the installer. The
# installer brings everything else (binary download, or bun/node/pnpm + build).
_install = f"export HOME=/root && {FROM_SOURCE}curl -fsSL {INSTALL_URL} | bash  # bust {time.time()}"
image = (
    modal.Image.debian_slim()
    .apt_install("curl", "ca-certificates", "unzip", "git", "tar", "xz-utils")
    .run_commands(
        "echo '### FRESH:' $(. /etc/os-release; echo $PRETTY_NAME) $(uname -m) "
        "'| pre:' bun=$(command -v bun||echo none) node=$(command -v node||echo none)",
        _install,
    )
)

secret = modal.Secret.from_dict({
    "AWS_BEARER_TOKEN_BEDROCK": os.environ.get("LAIN_BEDROCK_TOKEN", ""),
    "AWS_REGION": os.environ.get("LAIN_BEDROCK_REGION", "us-west-2"),
})

SCRIPT = r"""
set -uo pipefail
export HOME=/root
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$HOME/.local/share/lain-node/bin:$PATH"

echo "############ SMOKE: cli ############"
command -v lain || { echo "!! lain not on PATH"; exit 1; }
lain version || { echo "!! version failed"; exit 1; }
echo "--- doctor ---"; lain doctor || true
echo "--- help ---";   lain --help 2>&1 | head -3

if [ -n "${AWS_BEARER_TOKEN_BEDROCK:-}" ]; then
  echo "############ SMOKE: generation ############"
  mkdir -p "$HOME/.config/lain"
  printf '{"defaultProvider":"bedrock","defaultModel":"claude-sonnet-4-6"}\n' > "$HOME/.config/lain/config.json"
  lain "two forces that shape a coastline" --ext freeform --n 1 --m 1 -o "$HOME/t.db" || { echo "!! generation failed"; exit 1; }
  lain show root-1 --db "$HOME/t.db" 2>&1 | head -8
  # the node must have real content, not just a title
  WORDS=$(lain show root-1 --db "$HOME/t.db" 2>/dev/null | wc -w)
  [ "$WORDS" -gt 40 ] || { echo "!! node content too short ($WORDS words)"; exit 1; }
  echo "node content: $WORDS words ✓"
else
  echo "(no LAIN_BEDROCK_TOKEN — skipping generation)"
  mkdir -p "$HOME/.config/lain"
  printf '{"defaultProvider":"bedrock","defaultModel":"claude-sonnet-4-6"}\n' > "$HOME/.config/lain/config.json"
fi

echo "############ SMOKE: web serve ############"
lain serve "$HOME" --port 7799 >/tmp/serve.log 2>&1 &
for i in $(seq 1 40); do curl -sf http://localhost:7799/api/explorations >/dev/null 2>&1 && break; sleep 0.5; done
IDX=$(curl -s -o /dev/null -w "%{http_code}:%{size_download}" http://localhost:7799/)
EXP=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:7799/api/explorations)
CFG=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:7799/api/config)
echo "  / -> $IDX   /api/explorations -> $EXP   /api/config -> $CFG"
case "$IDX" in 200:*) ;; *) echo "!! / did not serve the client"; cat /tmp/serve.log; exit 1;; esac
[ "$EXP" = "200" ] && [ "$CFG" = "200" ] || { echo "!! api not healthy"; exit 1; }

echo "############ ALL GOOD ############"
"""


@app.function(image=image, secrets=[secret], timeout=300, cpu=2.0, memory=4096)
def smoke():
    p = subprocess.run(["bash", "-lc", SCRIPT])
    if p.returncode != 0:
        sys.exit(p.returncode)


@app.local_entrypoint()
def main():
    print(f"lain smoke: mode={MODE}  install={INSTALL_URL}  token={'yes' if os.environ.get('LAIN_BEDROCK_TOKEN') else 'no'}")
    smoke.remote()
