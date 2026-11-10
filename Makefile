PM2_APP := gwent-server
PORT := 8765

.PHONY: stats stats-week stats-month stats-all players logs online maintenance maintenance-off

stats:
	GWENT_APP=$(PM2_APP) bash scripts/gwent-stats.sh

stats-week:
	GWENT_APP=$(PM2_APP) DAYS=7 bash scripts/gwent-stats.sh

stats-month:
	GWENT_APP=$(PM2_APP) DAYS=30 bash scripts/gwent-stats.sh

stats-all:
	GWENT_APP=$(PM2_APP) DAYS=all bash scripts/gwent-stats.sh

# make players DAYS=30 WEEKS=8 MONTHS=all  (0 leaves a section out)
players:
	DAYS=$(DAYS) WEEKS=$(WEEKS) MONTHS=$(MONTHS) node scripts/player-stats.js

logs:
	pm2 logs $(PM2_APP)

online:
	@echo "$$(ss -Htn state established '( sport = :$(PORT) )' | wc -l) open connections"

MIN ?= 10
maintenance:
	@node -e 'require("fs").writeFileSync("server/maintenance.json", JSON.stringify({ at: Date.now() + $(MIN) * 60000 }) + "\n")'
	@echo "Players told: restart in $(MIN) min (at $$(date -d '+$(MIN) min' +%H:%M)). Cancel with: make maintenance-off"

maintenance-off:
	@rm -f server/maintenance.json
	@echo "Restart notice cancelled"
