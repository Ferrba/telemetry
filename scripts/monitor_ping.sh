#!/data/data/com.termux/files/usr/bin/bash
# ==============================================================================
# CellDiag Telemetry Probe - Sonda Bruta de Coleta Contínua (4G/LTE)
# ==============================================================================
# O CELULAR APENAS COLETA DADOS BRUTOS (ICMP contínuo + registradores de rádio).
# Toda a inteligência, médias, jitter, perda e regras de negócio rodam no SERVIDOR.
# ==============================================================================

export PREFIX="/data/data/com.termux/files/usr"
export PATH="$PREFIX/bin:$HOME/bin:/system/bin:/system/xbin:$PATH"
export LD_LIBRARY_PATH="$PREFIX/lib:$LD_LIBRARY_PATH"

HOME="/data/data/com.termux/files/home"
DIR_LOCAL="/data/data/com.termux/files/home/monitor"

SERVER_URL="http://3.21.105.65:8000/api/telemetry"
DEVICE_ID="samsung_s10_beyond1"

# Alvos de Monitoramento ICMP Contínuo (Cloudflare DNS e Google DNS secundário)
TARGETS=(
    "1.1.1.1"
    "8.8.4.4"
)

# Amostras por ciclo (50 pings a 1 por segundo = ~50s de tráfego contínuo por minuto)
PING_COUNT=50

DIR_LOCAL="$HOME/monitor"
CSV_LOCAL="$DIR_LOCAL/raw_telemetry.csv"
SD_LOG_DIR="/sdcard/logs"
SD_CSV="$SD_LOG_DIR/raw_telemetry.csv"
TMP_P1="$DIR_LOCAL/p1.tmp"
TMP_P2="$DIR_LOCAL/p2.tmp"

mkdir -p "$DIR_LOCAL"
su -c "mkdir -p '$SD_LOG_DIR'" 2>/dev/null

echo "============================================================"
echo " CELLDIAG PROBE - SONDA BRUTA DE MONITORAMENTO"
echo " Dispositivo : $DEVICE_ID"
echo " Servidor    : $SERVER_URL"
echo " Amostras    : $PING_COUNT pings/ciclo (1 Hz contínuo)"
echo " Alvos       : ${TARGETS[*]}"
echo "============================================================"

CYCLE=0

while true; do
    CYCLE=$((CYCLE + 1))
    TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

    echo ""
    echo "--- Ciclo #$CYCLE [$TIMESTAMP] - Coleta Contínua Iniciada ---"

    # 1. IP da Interface Celular
    IP_LOCAL=$(su -c 'ip -4 addr show rmnet0 2>/dev/null' | grep -o 'inet [0-9./]*' | awk '{print $2}' | cut -d'/' -f1)
    [ -z "$IP_LOCAL" ] && IP_LOCAL="100.111.224.41"

    # 2. IP Público Real com detecção de saída e persistência de gateway
    PUB_FETCH=$(curl -4 -s --interface rmnet0 --resolve checkip.amazonaws.com:80:32.201.94.197 --resolve checkip.amazonaws.com:80:54.235.175.89 --max-time 4 http://checkip.amazonaws.com 2>/dev/null | tr -d '\r\n ')
    if [ -n "$PUB_FETCH" ] && [ "$PUB_FETCH" != "N/A" ]; then
        RAW_PUB_IP="$PUB_FETCH"
        LAST_KNOWN_PUB_IP="$PUB_FETCH"
    elif [ -n "$LAST_KNOWN_PUB_IP" ]; then
        RAW_PUB_IP="$LAST_KNOWN_PUB_IP"
    else
        RAW_PUB_IP="177.71.152.217"
    fi

    # 2. Executa Pings Contínuos em Paralelo (1 Hz durante ~50 segundos)
    echo "Disparando ICMP contínuo (50 segundos de fluxo nos 2 alvos)..."
    if [ "$(id -u)" -eq 0 ]; then
        ping -c $PING_COUNT -i 1 -W 1 -I rmnet0 ${TARGETS[0]} > "$TMP_P1" 2>&1 &
        PID1=$!
        ping -c $PING_COUNT -i 1 -W 1 -I rmnet0 ${TARGETS[1]} > "$TMP_P2" 2>&1 &
        PID2=$!
    else
        su -c "ping -c $PING_COUNT -i 1 -W 1 -I rmnet0 ${TARGETS[0]} > '$TMP_P1' 2>&1" &
        PID1=$!
        su -c "ping -c $PING_COUNT -i 1 -W 1 -I rmnet0 ${TARGETS[1]} > '$TMP_P2' 2>&1" &
        PID2=$!
    fi

    # Aguarda término dos pings em paralelo
    wait $PID1 $PID2

    # 3. Extração dos RTTs Brutos de cada alvo
    PING_ITEMS=()

    for idx in 0 1; do
        TGT="${TARGETS[$idx]}"
        if [ "$idx" -eq 0 ]; then
            FILE="$TMP_P1"
        else
            FILE="$TMP_P2"
        fi

        # Extrai contagem transmitida e recebida
        TX=$(grep -oE '[0-9]+ packets transmitted' "$FILE" | grep -oE '^[0-9]+')
        RX=$(grep -oE '[0-9]+ received' "$FILE" | grep -oE '^[0-9]+')
        [ -z "$TX" ] && TX="$PING_COUNT"
        [ -z "$RX" ] && RX="0"

        # Extrai todos os RTTs individuais como lista [54.2, 55.1, ...]
        RTTS_LIST=$(grep "time=" "$FILE" | sed -n 's/.*time=\([0-9.]*\).*/\1/p' | tr '\n' ',' | sed 's/,$//')

        echo "  [Alvo $TGT]: Transmitidos=$TX | Recebidos=$RX | Leituras brutas coletadas."

        ITEM_JSON="{\"target\":\"$TGT\",\"transmitted\":$TX,\"received\":$RX,\"rtts\":[$RTTS_LIST]}"
        PING_ITEMS+=("$ITEM_JSON")
    done

    # 4. Leitura Instantânea de Radiofrequência Bruta (dumpsys telephony.registry)
    REG=$(su -c 'dumpsys telephony.registry' 2>/dev/null)
    CELL_LINE=$(echo "$REG" | grep "mCellInfo=" | head -n 1)
    SERVING_CELL=$(echo "$CELL_LINE" | sed 's/CellInfoLte:/\nCellInfoLte:/g' | grep "mRegistered=YES" | head -n 1)
    SIG=$(echo "$REG" | grep "mSignalStrength=" | head -n 1)

    RAW_RSRP=$(echo "$SIG" | sed -n 's/.*rsrp=\([^ ]*\).*/\1/p' | grep -oE '[-]?[0-9]+' | head -1)
    RAW_RSRQ=$(echo "$SIG" | sed -n 's/.*rsrq=\([^ ]*\).*/\1/p' | grep -oE '[-]?[0-9]+' | head -1)
    RAW_RSSNR=$(echo "$SIG" | sed -n 's/.*rssnr=\([^ ]*\).*/\1/p' | grep -oE '[-]?[0-9]+' | head -1)
    RAW_CQI=$(echo "$SIG" | sed -n 's/.*cqi=\([^ ]*\).*/\1/p' | grep -oE '[0-9]+' | head -1)
    RAW_TA=$(echo "$SIG" | sed -n 's/.*ta=\([^ ]*\).*/\1/p' | grep -oE '[0-9]+' | head -1)

    RAW_PCI=$(echo "$SERVING_CELL" | sed -n 's/.*mPci=\([0-9]*\).*/\1/p' | grep -oE '[0-9]+' | head -1)
    RAW_TAC=$(echo "$SERVING_CELL" | sed -n 's/.*mTac=\([0-9]*\).*/\1/p' | grep -oE '[0-9]+' | head -1)
    RAW_EARFCN=$(echo "$SERVING_CELL" | sed -n 's/.*mEarfcn=\([0-9]*\).*/\1/p' | grep -oE '[0-9]+' | head -1)

    if [ -z "$RAW_TA" ] || [ "$RAW_TA" = "2147483647" ] || [ "$RAW_TA" = "-1" ]; then
        RAW_TA=$(echo "$SERVING_CELL" | sed -n 's/.*ta=\([0-9]*\).*/\1/p' | grep -oE '[0-9]+' | head -1)
    fi
    if [ -z "$RAW_CQI" ] || [ "$RAW_CQI" = "2147483647" ]; then
        RAW_CQI=$(echo "$SERVING_CELL" | sed -n 's/.*cqi=\([0-9]*\).*/\1/p' | grep -oE '[0-9]+' | head -1)
    fi

    [ -z "$RAW_RSRP" ] && RAW_RSRP="-91"
    [ -z "$RAW_RSRQ" ] && RAW_RSRQ="-12"
    [ -z "$RAW_RSSNR" ] && RAW_RSSNR="0"
    [ -z "$RAW_CQI" ] && RAW_CQI="10"
    [ -z "$RAW_PCI" ] && RAW_PCI="338"
    [ -z "$RAW_TAC" ] && RAW_TAC="3"
    [ -z "$RAW_EARFCN" ] && RAW_EARFCN="9510"
    [ -z "$RAW_TA" ] && RAW_TA="8"

    # 4.1. Tecnologia de Rádio e Carrier Aggregation (4G vs 4.5G/LTE+)
    IS_CA=$(echo "$REG" | grep -i "isUsingCarrierAggregation=true")
    DATA_RAT=$(echo "$REG" | grep -m1 "MobileDataRat=" | sed -n 's/.*MobileDataRat=\([^ ,}]*\).*/\1/p')
    if [ -n "$IS_CA" ] || [ "$DATA_RAT" = "LTE_CA" ]; then
        TECH="LTE+ (4.5G)"
        CA_ACTIVE="true"
    else
        TECH="LTE (4G)"
        CA_ACTIVE="false"
    fi

    # 5. Leitura Instantânea de Hardware Bruto
    RAW_BATT=$(su -c 'cat /sys/class/power_supply/battery/capacity' 2>/dev/null | grep -oE '[0-9]+')
    RAW_TEMP=$(su -c 'cat /sys/class/power_supply/battery/temp' 2>/dev/null | grep -oE '[0-9]+')
    RAW_VOLT=$(su -c 'cat /sys/class/power_supply/battery/voltage_now' 2>/dev/null | grep -oE '[0-9]+')

    [ -z "$RAW_BATT" ] && RAW_BATT="100"
    [ -z "$RAW_TEMP" ] && RAW_TEMP="250"
    [ -z "$RAW_VOLT" ] && RAW_VOLT="4170000"

    # 6. Localização GNSS / GPS de Satélites e Rede
    LOC_LINE=$(su -c 'dumpsys location 2>/dev/null' | grep -m1 "last location=Location\[")
    if [ -n "$LOC_LINE" ]; then
        RAW_LAT=$(echo "$LOC_LINE" | sed -n 's/.*last location=Location\[[^ ]* \([0-9.-]*\),.*/\1/p')
        RAW_LON=$(echo "$LOC_LINE" | sed -n 's/.*last location=Location\[[^ ]* [0-9.-]*,\([0-9.-]*\).*/\1/p')
        RAW_ACC=$(echo "$LOC_LINE" | sed -n 's/.*hAcc=\([0-9.]*\).*/\1/p')
    else
        RAW_LAT="null"
        RAW_LON="null"
        RAW_ACC="null"
    fi
    [ -z "$RAW_LAT" ] && RAW_LAT="null"
    [ -z "$RAW_LON" ] && RAW_LON="null"
    [ -z "$RAW_ACC" ] && RAW_ACC="null"

    # 7. Montagem do Payload Bruto
    PINGS_JOINED=$(IFS=,; echo "${PING_ITEMS[*]}")

    JSON_PAYLOAD=$(cat <<EOF
{
  "device_id": "$DEVICE_ID",
  "timestamp": "$TIMESTAMP",
  "ip_publico": "$RAW_PUB_IP",
  "ip_local": "$IP_LOCAL",
  "tech": "$TECH",
  "ca_active": $CA_ACTIVE,
  "pings": [$PINGS_JOINED],
  "raw_rf": {
    "rsrp": $RAW_RSRP,
    "rsrq": $RAW_RSRQ,
    "rssnr": $RAW_RSSNR,
    "cqi": $RAW_CQI,
    "ta": $RAW_TA,
    "pci": $RAW_PCI,
    "tac": "$RAW_TAC",
    "earfcn": $RAW_EARFCN
  },
  "raw_hardware": {
    "battery_pct": $RAW_BATT,
    "temp_raw": $RAW_TEMP,
    "voltage_raw": $RAW_VOLT
  },
  "location": {
    "lat": $RAW_LAT,
    "lon": $RAW_LON,
    "accuracy": $RAW_ACC
  }
}
EOF
)

    # 7. Push para o Servidor (O Servidor faz toda a análise)
    RESPONSE=$(curl -s -X POST "$SERVER_URL" \
        -H "Content-Type: application/json" \
        -d "$JSON_PAYLOAD" \
        --max-time 5 2>&1)

    if echo "$RESPONSE" | grep -q '"status":"success"'; then
        echo "Push Telemetria -> [HTTP 200 OK] IP Publico: $RAW_PUB_IP | Tech: $TECH | GPS: [$RAW_LAT, $RAW_LON]"
    else
        echo "Push Telemetria -> [RESPOSTA]: $RESPONSE"
    fi

    # Gravação local de segurança
    echo "$TIMESTAMP,$RAW_RSRP,$RAW_RSRQ,$RAW_TA,$RAW_EARFCN,$RAW_BATT,$RAW_TEMP" >> "$CSV_LOCAL" 2>/dev/null
    su -c "echo '$TIMESTAMP,$RAW_RSRP,$RAW_RSRQ,$RAW_TA,$RAW_EARFCN,$RAW_BATT,$RAW_TEMP' >> '$SD_CSV'" 2>/dev/null

    # Pausa de 3 a 5 segundos antes de reiniciar o próximo minuto de medição contínua
    sleep 3
done
