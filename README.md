# ZA card game

Multiplayer Russian-language card game for 3–8 players. Existing combo rules are retained; reconnects use private session secrets and accepted actions are stored durably.

## Local run

Use Node.js 24 (`nvm use`).

```sh
npm ci
npm run check
npm test
npm start
```

Open http://localhost:3000 in independent browser sessions. Local data is stored in `data/rooms.json` (ignored by Git). Set `STATE_FILE` to choose another durable directory.

## Browser QA

```sh
npx playwright install chromium firefox webkit
PORT=3187 STATE_FILE=../browser-rooms.json npm start
# In another terminal:
node test/browser.cjs
node test/browser-game.cjs
```

`browser.cjs` uses isolated visual stress fixtures after establishing a real room. `browser-game.cjs` plays an actual game through UI actions in three independent browser contexts. `QA_OUTPUT` customizes screenshot output for the visual suite. Never run these mutation-based suites against production.

See [QA](docs/QA.md) and [deployment / backup / rollback](docs/OPERATIONS.md).
