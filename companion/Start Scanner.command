#!/bin/bash
set -euo pipefail
app="$HOME/Applications/Rift Warehouse Scanner.app"
if [ ! -d "$app" ]; then echo 'Run Install.command first.'; exit 1; fi
open "$app"
