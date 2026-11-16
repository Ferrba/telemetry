#!/data/data/com.termux/files/usr/bin/bash
# ==============================================================================
# CellDiag Agent v3 - sonda de borda (Android root + Termux)
# ==============================================================================
# O celular apenas REGISTRA amostras brutas, cada uma com seu horario (epoch),
# e ENVIA um lote a cada 60s. Nenhum calculo (media, jitter, perda, banda,
# distancia) e feito aqui: isso e responsabilidade da plataforma.
#
# Tres processos independentes:
#   pinger    - ICMP continuo, 1 pacote/s por alvo, sem pausas
#   collector - RF/IP local a cada 5s, IP publico a cada 60s (ou na troca de
#               IP local), GPS a cada 30s, bateria a cada 60s
#   sender    - a cada 60s fecha o lote, grava na fila (outbox) e envia;
#               se a plataforma nao responder, o lote fica na fila e e
#               reenviado no proximo minuto
#
# Uso: celldiag-agent.sh start | stop | restart | status | log
# Configuracao: /data/data/com.termux/files/home/.celldiag/agent.conf
# ==============================================================================

AGENT_VERSION="3.0.0"

export PREFIX="/data/data/com.termux/files/usr"
export PATH="$PREFIX/bin:/system/bin:/system/xbin:$PATH"
export LD_LIBRARY_PATH="$PREFIX/lib"

TERMUX_HOME="/data/data/com.termux/files/home"
BASE="$TERMUX_HOME/.celldiag"
CONF="$BASE/agent.conf"
SPOOL="$BASE/spool"
OUTBOX="$BASE/outbox"
WORK="$BASE/work"
LOGDIR="$BASE/logs"
LOG="$LOGDIR/agent.log"
SELF="$(readlink -f "$0")"
BASH_BIN="$PREFIX/bin/bash"

# ---------------------------------------------------------------- configuracao
SERVER_URL="http://3.21.105.65:8000/api/v3/ingest"
DEVICE_ID="samsung_s10_beyond1"
TARGETS="1.1.1.1 8.8.4.4"
IFACE="rmnet0"
RADIO_INTERVAL=5
GPS_INTERVAL=30
PUBIP_INTERVAL=60
DEVICE_INTERVAL=60
SEND_INTERVAL=60
OUTBOX_MAX=1440          # 24h de lotes guardados se a plataforma ficar fora
GPS_ACTIVE=1             # 1 = pede um fix novo ao Termux:API a cada GPS_INTERVAL
[ -f "$CONF" ] && . "$CONF"

mkdir -p "$SPOOL" "$OUTBOX" "$WORK" "$LOGDIR"

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') [$1] $2" >> "$LOG"
    if [ "$(stat -c %s "$LOG" 2>/dev/null || echo 0)" -gt 2000000 ]; then
        mv -f "$LOG" "$LOG.1"
    fi
}

# JSON: numero ou null / string ou null
jn() { case "$1" in ''|*[!0-9.-]*) echo null ;; *) echo "$1" ;; esac; }
js() { if [ -z "$1" ]; then echo null; else printf '"%s"' "$1"; fi; }

emit() { echo "$1|$2" >> "$SPOOL/events.jsonl"; }

# ============================================================================== PINGER
run_pinger() {
    local tgt="$1" run line ts seq rtt
    log pinger "iniciado alvo=$tgt iface=$IFACE"
    while true; do
        run=$(date +%s)
        ping -D -O -n -i 1 -W 1 -I "$IFACE" "$tgt" 2>&1 | while IFS= read -r line; do
            [[ "$line" =~ ^\[([0-9]+\.[0-9]+)\].*icmp_seq=([0-9]+) ]] || continue
            ts="${BASH_REMATCH[1]}"
            seq="${BASH_REMATCH[2]}"
            if [[ "$line" =~ time=([0-9.]+) ]]; then
                rtt="${BASH_REMATCH[1]}"
            else
                rtt=""      # "no answer yet" / unreachable = pacote sem resposta
            fi
            printf '%s,%s,%s,%s,%s\n' "$ts" "$tgt" "$run" "$seq" "$rtt" >> "$SPOOL/pings.csv"
        done
        # ping saiu (interface caiu / sem rede): registra e reinicia com novo run
        log pinger "ping para $tgt encerrou, reiniciando em 2s"
        sleep 2
    done
}

# ============================================================================== COLLECTOR
collect_radio() {
    local now="$1" reg sig cell svc
    reg=$(dumpsys telephony.registry 2>/dev/null)
    sig=$(echo "$reg" | grep -m1 "mSignalStrength=")
    cell=$(echo "$reg" | grep -m1 "mCellInfo=" | sed 's/CellInfoLte:/\nCellInfoLte:/g' | grep -m1 "mRegistered=YES")
    svc=$(echo "$reg" | grep -m1 "mServiceState=")

    # Sinal: preferir mSignalStrength (atualizado com mais frequencia)
    local rsrp rsrq rssnr cqi ta pci earfcn tac ci mcc mnc op rat ca
    rsrp=$(echo "$sig"  | grep -oE 'mLte=CellSignalStrengthLte: [^,]*' | grep -oE 'rsrp=-?[0-9]+'  | cut -d= -f2)
    rsrq=$(echo "$sig"  | grep -oE 'mLte=CellSignalStrengthLte: [^,]*' | grep -oE 'rsrq=-?[0-9]+'  | cut -d= -f2)
    rssnr=$(echo "$sig" | grep -oE 'mLte=CellSignalStrengthLte: [^,]*' | grep -oE 'rssnr=-?[0-9]+' | cut -d= -f2)
    cqi=$(echo "$sig"   | grep -oE 'mLte=CellSignalStrengthLte: [^,]*' | grep -oE ' cqi=[0-9]+'     | cut -d= -f2)
    # Celula servidora: TA, PCI, canal, identificadores
    [ -z "$rsrp" ] && rsrp=$(echo "$cell" | grep -oE 'rsrp=-?[0-9]+' | head -1 | cut -d= -f2)
    [ -z "$rsrq" ] && rsrq=$(echo "$cell" | grep -oE 'rsrq=-?[0-9]+' | head -1 | cut -d= -f2)
    ta=$(echo "$cell"     | grep -oE ' ta=[0-9]+'       | head -1 | cut -d= -f2)
    pci=$(echo "$cell"    | grep -oE 'mPci=[0-9]+'      | head -1 | cut -d= -f2)
    earfcn=$(echo "$cell" | grep -oE 'mEarfcn=[0-9]+'   | head -1 | cut -d= -f2)
    # TAC/CI podem vir mascarados pelo Android (ex: 3***1): nesse caso, null
    tac=$(echo "$cell"    | grep -oE 'mTac=[0-9]+ '     | head -1 | tr -dc '0-9')
    ci=$(echo "$cell"     | grep -oE 'mCi=[0-9]+ '      | head -1 | tr -dc '0-9')
    mcc=$(echo "$cell"    | grep -oE 'mMcc=[0-9]+'      | head -1 | cut -d= -f2)
    mnc=$(echo "$cell"    | grep -oE 'mMnc=[0-9]+'      | head -1 | cut -d= -f2)
    op=$(echo "$cell"     | grep -oE 'mAlphaLong=[^ ]+' | head -1 | cut -d= -f2)
    rat=$(echo "$svc" | grep -oE 'getRilDataRadioTechnology=[0-9]+\([A-Za-z_]+\)' | head -1 | sed 's/.*(\(.*\))/\1/')
    ca=$(echo "$svc" | sed -n 's/.*domain=PS transportType=WWAN//p' | grep -oE 'isUsingCarrierAggregation=[a-z]+' | head -1 | cut -d= -f2)
    [ "$ca" != "true" ] && [ "$ca" != "false" ] && ca=null

    emit radio "{\"ts\":$now,\"rat\":$(js "$rat"),\"ca\":$ca,\"rsrp\":$(jn "$rsrp"),\"rsrq\":$(jn "$rsrq"),\"rssnr\":$(jn "$rssnr"),\"cqi\":$(jn "$cqi"),\"ta\":$(jn "$ta"),\"pci\":$(jn "$pci"),\"earfcn\":$(jn "$earfcn"),\"tac\":$(jn "$tac"),\"ci\":$(jn "$ci"),\"mcc\":$(js "$mcc"),\"mnc\":$(js "$mnc"),\"operator\":$(js "$op")}"
}

local_ip() {
    # IP de origem realmente usado para sair pela interface celular
    ip -4 route get 1.1.1.1 oif "$IFACE" 2>/dev/null | grep -oE 'src [0-9.]+' | head -1 | cut -d' ' -f2
}

check_public_ip() {
    # Roda em segundo plano para nao atrasar o ciclo de 5s.
    # Consulta o proprio servidor na AWS (IP direto, sem depender de DNS na rmnet0).
    local now="$1" ipl="$2" trig="$3" pub base_url
    base_url="${SERVER_URL%/api/*}"
    pub=$(curl -4 -s --interface "$IFACE" --connect-timeout 3 --max-time 5 "$base_url/api/v3/myip" 2>/dev/null | tr -d '\r\n ')
    [[ "$pub" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || pub=""
    emit network "{\"ts\":$now,\"iface\":\"$IFACE\",\"ip_local\":$(js "$ipl"),\"ip_public\":$(js "$pub"),\"pub_checked\":true,\"trigger\":\"$trig\"}"
}

collect_gps() {
    local now="$1" up line
    up=$(cut -d' ' -f1 /proc/uptime)
    # Escolhe a posicao mais recente entre os provedores (gps/network/fused)
    line=$(dumpsys location 2>/dev/null | awk -v up="$up" '
        /last location=Location\[/ {
            s=$0; sub(/.*last location=Location\[/, "", s)
            split(s, a, " "); prov=a[1]; split(a[2], ll, ","); lat=ll[1]; lon=ll[2]
            acc=""; if (match(s, /hAcc=[0-9.]+/)) acc=substr(s, RSTART+5, RLENGTH-5)
            alt=""; if (match(s, /alt=-?[0-9.]+/)) alt=substr(s, RSTART+4, RLENGTH-4)
            secs=-1
            if (match(s, /et=\+[0-9dhms]+/)) {
                e=substr(s, RSTART+4, RLENGTH-4); secs=0
                while (match(e, /^[0-9]+(ms|d|h|m|s)/)) {
                    tok=substr(e, 1, RLENGTH); e=substr(e, RLENGTH+1)
                    n=tok+0; u=tok; gsub(/[0-9]/, "", u)
                    if (u=="d") secs+=n*86400; else if (u=="h") secs+=n*3600
                    else if (u=="m") secs+=n*60; else if (u=="s") secs+=n
                    else if (u=="ms") secs+=n/1000
                }
            }
            if (secs < 0) next
            age=up-secs
            if (best=="" || age < best) { best=age; out=prov" "lat" "lon" "acc" "alt" "age }
        }
        END { print out }')
    [ -z "$line" ] && return
    set -- $line
    emit gps "{\"ts\":$now,\"provider\":$(js "$1"),\"lat\":$(jn "$2"),\"lon\":$(jn "$3"),\"acc\":$(jn "$4"),\"alt\":$(jn "$5"),\"fix_age_s\":$(jn "$6")}"
}

request_gps_fix() {
    # Pede um fix novo ao Termux:API (precisa de "Permitir o tempo todo" na
    # permissao de localizacao do app Termux:API). O resultado atualiza o
    # cache do Android, lido por collect_gps no proximo ciclo.
    local tuid
    tuid=$(stat -c %u /data/data/com.termux 2>/dev/null)
    [ -z "$tuid" ] && return
    ( su "$tuid" -c "PATH=$PREFIX/bin:/system/bin LD_LIBRARY_PATH=$PREFIX/lib timeout 25 $PREFIX/bin/termux-location -p gps -r once >/dev/null 2>&1" ) >/dev/null 2>&1 &
}

collect_device() {
    local now="$1" b t v st
    b=$(cat /sys/class/power_supply/battery/capacity 2>/dev/null)
    t=$(cat /sys/class/power_supply/battery/temp 2>/dev/null)
    v=$(cat /sys/class/power_supply/battery/voltage_now 2>/dev/null)
    st=$(cat /sys/class/power_supply/battery/status 2>/dev/null)
    emit device "{\"ts\":$now,\"battery_pct\":$(jn "$b"),\"temp_raw\":$(jn "$t"),\"voltage_raw\":$(jn "$v"),\"charging\":$(js "$st")}"
}

run_collector() {
    log collector "iniciado radio=${RADIO_INTERVAL}s gps=${GPS_INTERVAL}s pubip=${PUBIP_INTERVAL}s device=${DEVICE_INTERVAL}s"
    local now ipl last_ipl="" last_pub=0 last_gps=0 last_gps_req=0 last_dev=0
    while true; do
        now=$(date +%s)

        collect_radio "$now"

        ipl=$(local_ip)
        if [ -n "$last_ipl" ] && [ "$ipl" != "$last_ipl" ]; then
            log collector "IP local mudou: $last_ipl -> $ipl"
            check_public_ip "$now" "$ipl" "local_change" &
            last_pub=$now
        elif [ $((now - last_pub)) -ge "$PUBIP_INTERVAL" ]; then
            check_public_ip "$now" "$ipl" "periodic" &
            last_pub=$now
        else
            emit network "{\"ts\":$now,\"iface\":\"$IFACE\",\"ip_local\":$(js "$ipl"),\"ip_public\":null,\"pub_checked\":false,\"trigger\":\"periodic\"}"
        fi
        last_ipl="$ipl"

        if [ "$GPS_ACTIVE" = "1" ] && [ $((now - last_gps_req)) -ge "$GPS_INTERVAL" ]; then
            request_gps_fix
            last_gps_req=$now
        fi
        if [ $((now - last_gps)) -ge "$GPS_INTERVAL" ]; then
            collect_gps "$now"
            last_gps=$now
        fi
        if [ $((now - last_dev)) -ge "$DEVICE_INTERVAL" ]; then
            collect_device "$now"
            last_dev=$now
        fi

        # dorme ate o proximo multiplo de RADIO_INTERVAL (relogio fixo, sem deriva)
        now=$(date +%s)
        sleep $(( RADIO_INTERVAL - now % RADIO_INTERVAL ))
    done
}

# ============================================================================== SENDER
build_batch() {
    # Fecha o lote atual e grava em outbox/batch_<epoch>.json
    local now="$1" prev="$2" dir="$WORK/$1" out
    mkdir -p "$dir"
    [ -f "$SPOOL/pings.csv" ]    && mv "$SPOOL/pings.csv" "$dir/pings.csv"
    [ -f "$SPOOL/events.jsonl" ] && mv "$SPOOL/events.jsonl" "$dir/events.jsonl"
    sleep 1   # deixa terminar alguma escrita que ja estava em andamento
    touch "$dir/pings.csv" "$dir/events.jsonl"

    out="$OUTBOX/batch_$now.json"
    {
        printf '{"device_id":"%s","batch_id":"%s-%s","agent_version":"%s","window_start":%s,"window_end":%s,"pings":[' \
            "$DEVICE_ID" "$DEVICE_ID" "$now" "$AGENT_VERSION" "$prev" "$now"
        awk -F, 'BEGIN{ORS=""} NF>=4 { if (n++) print ","; r=($5==""?"null":$5); printf "[%s,\"%s\",%s,%s,%s]", $1, $2, $3, $4, r }' "$dir/pings.csv"
        for kind in radio network gps device; do
            printf '],"%s":[' "$kind"
            awk -v k="$kind" 'BEGIN{ORS=""} { p=index($0, "|"); if (substr($0, 1, p-1)==k) { if (n++) print ","; print substr($0, p+1) } }' "$dir/events.jsonl"
        done
        printf ']}'
    } > "$out.tmp" && mv "$out.tmp" "$out"
    rm -rf "$dir"
}

prune_outbox() {
    local n
    n=$(ls "$OUTBOX" 2>/dev/null | grep -c '^batch_.*\.json$')
    if [ "$n" -gt "$OUTBOX_MAX" ]; then
        ls "$OUTBOX" | grep '^batch_.*\.json$' | sort | head -n $((n - OUTBOX_MAX)) | while read -r f; do
            rm -f "$OUTBOX/$f"
        done
        log sender "fila cheia: $((n - OUTBOX_MAX)) lotes antigos descartados"
    fi
}

flush_outbox() {
    # Envia do MAIS RECENTE para o mais antigo (sort -r) para que o painel em
    # tempo real esteja sempre atualizado no minuto corrente, e drena a fila
    # acumulada logo em seguida sem abortar no primeiro timeout pontual.
    local f code sent=0 fails=0
    for f in $(ls "$OUTBOX" 2>/dev/null | grep '^batch_.*\.json$' | sort -r | head -n 30); do
        rm -f "$WORK/resp.txt"
        code=$(curl -4 -s --interface "$IFACE" -o "$WORK/resp.txt" -w '%{http_code}' \
               --connect-timeout 4 --max-time 10 --retry 2 --retry-delay 1 \
               -H "Content-Type: application/json" -H "X-Sent-At: $(date +%s)" \
               --data-binary "@$OUTBOX/$f" "$SERVER_URL" 2>/dev/null)
        if [ "$code" = "200" ] && grep -q '"status":"ok"' "$WORK/resp.txt" 2>/dev/null; then
            rm -f "$OUTBOX/$f"
            sent=$((sent + 1))
        else
            fails=$((fails + 1))
            log sender "falha ao enviar $f (HTTP ${code:-000}): $(head -c 160 "$WORK/resp.txt" 2>/dev/null)"
            [ "$fails" -ge 3 ] && break
        fi
    done
    local left
    left=$(ls "$OUTBOX" 2>/dev/null | grep -c '^batch_.*\.json$')
    log sender "enviados=$sent pendentes=$left"
}

run_sender() {
    log sender "iniciado url=$SERVER_URL intervalo=${SEND_INTERVAL}s"
    local now prev
    prev=$(date +%s)
    while true; do
        now=$(date +%s)
        sleep $(( SEND_INTERVAL - now % SEND_INTERVAL ))
        now=$(date +%s)
        build_batch "$now" "$prev"
        prev=$now
        prune_outbox
        flush_outbox
    done
}

# ============================================================================== CONTROLE
agent_pids() {
    pgrep -f "celldiag-agent.sh _(pinger|collector|sender)" 2>/dev/null
}

do_stop() {
    local p
    for p in $(agent_pids); do kill "$p" 2>/dev/null; done
    pkill -f "ping -D -O -n -i 1" 2>/dev/null
    sleep 1
    for p in $(agent_pids); do kill -9 "$p" 2>/dev/null; done
    pkill -9 -f "ping -D -O -n -i 1" 2>/dev/null
    log control "agente parado"
}

do_start() {
    if [ -n "$(agent_pids)" ]; then
        echo "Agente ja esta rodando. Use: $0 restart"
        return 1
    fi
    local t
    for t in $TARGETS; do
        nohup "$BASH_BIN" "$SELF" _pinger "$t" >/dev/null 2>&1 < /dev/null &
    done
    nohup "$BASH_BIN" "$SELF" _collector >/dev/null 2>&1 < /dev/null &
    nohup "$BASH_BIN" "$SELF" _sender    >/dev/null 2>&1 < /dev/null &
    log control "agente v$AGENT_VERSION iniciado alvos=[$TARGETS] url=$SERVER_URL"
    sleep 1
    do_status
}

do_status() {
    echo "CellDiag Agent v$AGENT_VERSION"
    echo "  Servidor : $SERVER_URL"
    echo "  Alvos    : $TARGETS (iface $IFACE)"
    echo "  Processos:"
    ps -ef | grep -E "celldiag-agent.sh _(pinger|collector|sender)" | grep -v grep | awk '$3==1 { $1=$3=$4=$5=$6=$7=""; print "   "$0 }'
    echo "  Fila (lotes nao enviados): $(ls "$OUTBOX" 2>/dev/null | grep -c '^batch_.*\.json$')"
    echo "  Ultimas linhas do log:"
    tail -n 5 "$LOG" 2>/dev/null | sed 's/^/    /'
}

# Precisa de root (dumpsys, ping -I, sysfs)
if [ "$(id -u)" -ne 0 ]; then
    exec su -c "$BASH_BIN $SELF $*"
fi

case "$1" in
    _pinger)    run_pinger "$2" ;;
    _collector) run_collector ;;
    _sender)    run_sender ;;
    start)      do_start ;;
    stop)       do_stop; echo "Agente parado." ;;
    restart)    do_stop; do_start ;;
    status)     do_status ;;
    flush)      flush_outbox; do_status ;;
    log)        tail -n 50 -f "$LOG" ;;
    *)          echo "Uso: $0 start|stop|restart|status|flush|log" ;;
esac
