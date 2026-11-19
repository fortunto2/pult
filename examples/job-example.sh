#!/usr/bin/env bash
# A scheduled job is your own script that calls bot-item. Run it from launchd or cron.
# pult has no job scheduler on purpose: a job decides what is worth your attention, the bot only shows it.
set -euo pipefail
PULT="${PULT_HOME:-$HOME/pult}"

# A card with a link, why it matters and a More button (a read-only job that fills in the details when you tap it).
python3 "$PULT/bin/bot-item" card --id "invoice:2026-001" --title "Invoice 2026-001 is unpaid" \
  --body "Due Friday." --link "https://example.com/invoices/2026-001" \
  --do "Pay invoice 2026-001" --why "late fee after Friday" --cost "5 min" --verb "Paid"

# A living note: the same key edits one message in place, a new date key replaces yesterday's.
printf 'Morning sweep\n2 new, 1 waiting\n' | python3 "$PULT/bin/bot-say" --key "sweep-$(date +%F)" --kind inbox
