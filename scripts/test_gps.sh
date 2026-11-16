LOC_LINE=$(dumpsys location 2>/dev/null | grep -m1 "last location=Location\[")
if [ -n "$LOC_LINE" ]; then
    LAT=$(echo "$LOC_LINE" | sed -n 's/.*last location=Location\[[^ ]* \([0-9.-]*\),.*/\1/p')
    LON=$(echo "$LOC_LINE" | sed -n 's/.*last location=Location\[[^ ]* [0-9.-]*,\([0-9.-]*\).*/\1/p')
    ACC=$(echo "$LOC_LINE" | sed -n 's/.*hAcc=\([0-9.]*\).*/\1/p')
    echo "PARSE SUCESSO: LAT=$LAT | LON=$LON | ACC=$ACC"
else
    echo "FALHA: Nao encontrou localizacao"
fi