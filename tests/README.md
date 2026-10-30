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
node e2e-deck-filters.js                             # deck builder filter tabs: which cards each tab shows, per panel, reset on faction change
node e2e-muster.js                                   # muster: called cards highlighted, fly from their own slot, one at a time
node e2e-multiplayer.js                              # full online match, checksums, disconnect
node e2e-muster-online.js                            # online muster: same board, hand, deck order and checksums on both clients
node e2e-rematch.js                                  # post-match re-ready + mid-game exit
node e2e-afk.js                                      # AFK turns: both players told, the waiting one passes the round for the AFK one
node e2e-chat.js                                     # quick chat opt-in, opponent state, cooldown, picker, no desync
node e2e-text-chat.js                                # text chat: settings cog, log, sanitizing, mute, T shortcut, no desync
node e2e-music.js                                    # music panel: nothing from YouTube until play, volume saved, tracks, prev/next, seek
node e2e-history.js                                  # match history: how each ending is recorded, the window, export/import, full storage
node e2e-replay.js                                   # a bot plays matches, their recordings must replay to the same state
node e2e-replay-ui.js                                # the replay player: controls, keys, seeking, leaving, one match downloaded and watched elsewhere
node e2e-replay-reveal.js                            # replays: the opponent's hand, each card choice shown; the match plays out the same either way
```
