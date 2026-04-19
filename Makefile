# RetroQuest — developer shortcuts
# Usage: make <target>

.PHONY: install dev start lint deploy-backend deploy-frontend setup

install:
	npm install

dev:
	npx nodemon src/index.js

start:
	node src/index.js

lint:
	node --check src/index.js
	node --check src/routes/rooms.js
	node --check src/routes/ice.js
	node --check src/routes/cards.js
	node --check src/routes/review.js
	node --check src/routes/chat.js
	node --check src/routes/leaderboard.js
	node --check src/routes/ai.js
	node --check src/socket/handlers.js
	@echo "✓ All files parse correctly"

health:
	curl -s http://localhost:3001/health | node -e "process.stdin.resume(); let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>console.log(JSON.parse(d)))"

setup:
	bash setup.sh

deploy-backend:
	railway up

deploy-frontend:
	cd .. && vercel --prod
