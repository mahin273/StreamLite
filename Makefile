COMPOSE_FILE := deploy/docker-compose.yml

.PHONY: up down down-v restart ps logs lint typecheck test clean

up:
	docker compose -f $(COMPOSE_FILE) --profile core up -d

down:
	docker compose -f $(COMPOSE_FILE) --profile core down

down-v:
	docker compose -f $(COMPOSE_FILE) --profile core down -v

restart: down up

ps:
	docker compose -f $(COMPOSE_FILE) --profile core ps

logs:
	docker compose -f $(COMPOSE_FILE) --profile core logs -f

lint:
	npm run lint

typecheck:
	npm run typecheck

test:
	npm test

clean:
	npm run clean
