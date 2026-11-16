REG=$(dumpsys telephony.registry 2>/dev/null)
IS_CA=$(echo "$REG" | grep -i "isUsingCarrierAggregation=true")
DATA_RAT=$(echo "$REG" | grep -m1 "MobileDataRat=" | sed -n 's/.*MobileDataRat=\([^ ,}]*\).*/\1/p')
if [ -n "$IS_CA" ] || [ "$DATA_RAT" = "LTE_CA" ]; then
    TECH="LTE+ (4.5G)"
    CA_ACTIVE="true"
else
    TECH="LTE (4G)"
    CA_ACTIVE="false"
fi
echo "TECH PARSE SUCESSO: TECH=$TECH | CA=$CA_ACTIVE | RAT=$DATA_RAT"