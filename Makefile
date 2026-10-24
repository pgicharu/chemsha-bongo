# Shortcuts for everyday commands. `make help` lists the targets.

.DEFAULT_GOAL := help
COMPOSE := docker compose
# Production: the base stack plus docker-compose.prod.yml (DEPLOY.md).
PROD := $(COMPOSE) -f docker-compose.yml -f docker-compose.prod.yml
# ngrok from PATH, or a binary in the repository root.
NGROK := $(shell command -v ngrok 2>/dev/null || echo ./ngrok)

.PHONY: help
help: ## Show this list
	@grep -E '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "} {printf "  \033[1m%-19s\033[0m %s\n", $$1, $$2}'

# --- Start and stop ----------------------------------------------------------
.PHONY: env pull up down restart

env: ## Create .env from .env.example if it doesn't exist yet
	@test -f .env || (cp .env.example .env && echo "Created .env from .env.example")

pull: ## Download every image and build the app image
	$(COMPOSE) --profile mail pull --ignore-buildable
	$(COMPOSE) build

up: env ## Build and start the stack in the background
	$(COMPOSE) up -d --build

down: ## Stop the stack (data is kept)
	$(COMPOSE) --profile mail --profile traffic down

restart: ## Restart only the app container (does not re-read .env; use make up for that)
	$(COMPOSE) restart app

# --- Look around -------------------------------------------------------------
.PHONY: ps logs urls stats psql

ps: ## Show running containers and their health
	$(COMPOSE) ps

logs: ## Follow the app's logs
	$(COMPOSE) logs -f app

urls: ## Print every web page in the stack and its address
	@printf '%s\n' \
	  'App            http://localhost:3000' \
	  'Grafana        http://localhost:3001   (no login needed; admin / admin also works)' \
	  'Uptime Kuma    http://localhost:3002   (create an admin account on first visit)' \
	  'Prometheus     http://localhost:9090   (Status > Target health)' \
	  'Alloy          http://localhost:12345  (the log pipeline, live)' \
	  'Netdata        http://localhost:19999' \
	  'Mailpit        http://localhost:8025   (only after make mail-up)'

stats: ## Show each container's memory and CPU use right now
	docker stats --no-stream

psql: ## Open a SQL prompt on the database
	$(COMPOSE) exec postgres sh -c 'psql -U "$$POSTGRES_USER" -d "$$POSTGRES_DB"'

# --- Optional extras ---------------------------------------------------------
.PHONY: traffic-up traffic-down bots mail-up mail-down tunnel

traffic-up: ## Start bot traffic: a bot host plays live games with 15 bots, in a loop
	$(COMPOSE) --profile traffic up -d --build traffic

traffic-down: ## Stop bot traffic (the game in progress is ended cleanly)
	$(COMPOSE) --profile traffic stop traffic

bots: ## Run bot players: make bots ARGS="--code 123456" | ARGS="--quiz <slug>" | ARGS="--help"
	$(COMPOSE) exec app npm run bots -s -- $(ARGS)

mail-up: ## Start Mailpit (catches emails, inbox at http://localhost:8025)
	$(COMPOSE) --profile mail up -d mailpit

mail-down: ## Stop Mailpit
	$(COMPOSE) --profile mail stop mailpit

tunnel: ## Share the local app on the internet with ngrok
	$(NGROK) http 3000

# --- Reference dashboards and tools ------------------------------------------
.PHONY: dashboards-up chaos rescore migrate

dashboards-up: env ## Start the stack with the reference dashboards
	$(COMPOSE) -f docker-compose.yml -f docker-compose.dashboards.yml up -d --build

chaos: ## Flip a chaos switch: make chaos ARGS="slow-scoring on" | ARGS=status | ARGS="all off"
	$(COMPOSE) exec app npm run chaos -s -- $(ARGS)

rescore: ## Re-score a quiz from its stored answers: make rescore ARGS="--quiz 12 --dry-run"
	$(COMPOSE) exec app npm run rescore -s -- $(ARGS)

migrate: ## Apply pending database migrations (the app also does this when it starts)
	$(COMPOSE) exec app node src/migrate.js

# --- Danger ------------------------------------------------------------------
.PHONY: reset

reset: ## DANGER: stop everything and delete all data, including the database
	$(COMPOSE) --profile mail --profile traffic down -v

# --- Production (DEPLOY.md) ---------------------------------------------------
# On the server use only the prod-* targets; never `make up`,
# `make dashboards-up` or `make reset`.
.PHONY: prod-up prod-dashboards-up prod-down prod-logs prod-ps prod-chaos \
        prod-rescore prod-caddy-reload prod-backup prod-restore

prod-up: ## SERVER: build and start (or update) the production stack
	$(PROD) up -d --build --remove-orphans

prod-dashboards-up: ## SERVER: the same, plus the reference dashboards
	$(PROD) -f docker-compose.dashboards.yml up -d --build --remove-orphans

prod-down: ## SERVER: stop the production stack (data and certificates are kept)
	$(PROD) --profile '*' down

prod-logs: ## SERVER: follow the app's and Caddy's logs
	$(PROD) logs -f --tail=100 app caddy

prod-ps: ## SERVER: show the production containers and their health
	$(PROD) ps

prod-chaos: ## SERVER: chaos switch: make prod-chaos ARGS=status | ARGS="slow-scoring on"
	$(PROD) exec app npm run chaos -s -- $(ARGS)

prod-rescore: ## SERVER: re-score a quiz: make prod-rescore ARGS="--quiz 12 --dry-run"
	$(PROD) exec app npm run rescore -s -- $(ARGS)

prod-caddy-reload: ## SERVER: apply an edited deploy/Caddyfile without dropping anyone
	$(PROD) exec -w /etc/caddy caddy caddy reload

prod-backup: ## SERVER: dump the database now (deploy/backup.sh)
	./deploy/backup.sh

prod-restore: ## SERVER: restore a dump (asks first): make prod-restore FILE=<path to .dump>
	./deploy/restore.sh $(FILE)
