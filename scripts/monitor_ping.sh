#!/data/data/com.termux/files/usr/bin/bash
# Wrapper de compatibilidade para o agente v3 (celldiag-agent.sh)
DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$DIR/celldiag-agent.sh" "${@:-restart}"
