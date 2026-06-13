# Tests

End-to-end tests for the online multiplayer mode.

## Prerequisites (one-time)

```
cd tests
npm init -y
npm install ws playwright-core
npx playwright-core install chromium
```

## Running the tests

Start the relay server and serve the game over HTTP, then run the suites:

```
node ../server/server.js &                          # relay on :8765
python3 -m http.server 8077 --directory .. &        # game on :8077
node relay-protocol.js                               # tests room creation, joining, and message relay on the server
node e2e-singleplayer.js                             # vs-AI
node e2e-multiplayer.js                              # full online match, checksums, disconnect
node e2e-rematch.js                                  # post-match re-ready + mid-game exit
```
