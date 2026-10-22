PM2_APP := gwent-server
PORT := 8765

.PHONY: stats stats-week stats-month stats-all logs online

stats:
	GWENT_APP=$(PM2_APP) bash scripts/gwent-stats.sh

stats-week:
	GWENT_APP=$(PM2_APP) DAYS=7 bash scripts/gwent-stats.sh

stats-month:
	GWENT_APP=$(PM2_APP) DAYS=30 bash scripts/gwent-stats.sh

stats-all:
	GWENT_APP=$(PM2_APP) DAYS=all bash scripts/gwent-stats.sh

logs:
	pm2 logs $(PM2_APP)

online:
	@echo "$$(ss -Htn state established '( sport = :$(PORT) )' | wc -l) open connections"
