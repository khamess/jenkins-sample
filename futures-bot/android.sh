#!/data/data/com.termux/files/usr/bin/bash
# Lancement du bot sur Android (Termux).
#   bash android.sh            -> mode paper (argent fictif)
#   bash android.sh live       -> mode live (argent réel, voir README)
#   bash android.sh liste      -> génère seulement la liste du jour
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null || { echo "Node.js manquant : lance d'abord  pkg install nodejs-lts"; exit 1; }
[ -f .env ] || { cp .env.example .env; echo "Fichier .env créé à partir de .env.example"; }
# Empêche Android d'endormir le bot (notification Termux "wake lock")
command -v termux-wake-lock >/dev/null && termux-wake-lock
case "$1" in
  live)  node src/index.js --mode=live ;;
  liste) node src/index.js --scan-only ;;
  *)     echo "Tableau de bord : ouvre http://127.0.0.1:8790 dans Chrome"; node src/index.js --mode=paper ;;
esac
command -v termux-wake-unlock >/dev/null && termux-wake-unlock
