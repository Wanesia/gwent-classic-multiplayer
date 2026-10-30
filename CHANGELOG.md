# Changelog

## 1.3.1 (2026-10-30)

A small update that makes waiting for an opponent and listening to the music a bit nicer, plus an Eredin fix.

### Quality of life
- **Match found alert:** while you wait in quick match or with a room code, the tab flashes when an opponent joins, so you can't miss it from another tab.
- **Horn sound (optional):** a horn also plays when an opponent joins. It's on by default; turn it off, or set its own volume, on the waiting screen. It plays even with sound effects off.
- **Desktop notification (optional):** off by default. Tick the box on the waiting screen if you want one.
- **Music panel:** the music button now opens a small player. Play, pause, change the volume or mute, drag through the current track, skip to the next or previous one, or pick any of the five tracks.

### Fixes
- **Eredin, Destroyer of Worlds** now needs at least 2 cards in hand. Before, with fewer cards you could take any card from your deck for free.
- With an empty hand and a leader you can't use, you now pass automatically.

## 1.3.0 (2026-10-25)

Every match is now saved to a match history, and you can watch any of them again as a replay. After a match, the final board stays on the table so you can look it over.

### Match history
- **Every match is recorded:** open *Match history* from the main menu to see your results, factions, leaders and round scores, with statistics and filters. Star the matches you want to keep.
- **How matches count:** leaving, closing the tab or losing your own connection counts as a defeat, and your opponent dropping out is a walkover win. A desync is listed but not counted, and it now ends the match for both players.
- **Export and import:** save your history to a file and import it on another device, merged with the history there or replacing it.
- **Saved only in your browser:** nothing is uploaded, so clearing site data, a private window, or another browser or device means no history. Safari deletes site data after 7 days without a visit. Use *Export* to keep a copy.
- **When storage runs out,** the oldest unstarred replays are deleted first. Match results and starred matches are always kept.

### Replays
- **Watch any match** from the match history, against the computer or online. You can also download a single replay as a file, and *Import* adds it on another device.
- **Controls:** step through moves, jump to the end of a round, play and pause, at 0.5x to 4x speed. Space, the arrow keys (with Shift for whole rounds), M and Escape work too. Fold the controls into a small bar and drag them anywhere on the board.
- **Opponent's hand:** press **O** to see their real hand as they draw and play cards.
- **Card choices:** press **C** to see every redraw, revive and leader pick the way the player saw it.
- **Older replays:** a replay recorded on an older version of the game may stop partway if an update changes how a card plays out.

### End of a match
- **Look at the final board:** the last round's board stays as it was when both players passed. Hide the results with the minimize button to look at rows, weather and hands in the card viewer, and bring them back with Escape or the exit button.
- **Back to the main menu:** the X on the results screen now takes you straight to the main menu. Online, that leaves the room.
- If your opponent leaves while the results are up, close the notice to keep looking at the board.

### Online play
- **AFK opponents:** if a player takes more than a minute on their turn, both players are told, and the waiting player can pass the round for them.

### Deck builder
- **Filter tabs:** like in The Witcher 3, the collection and your deck have tabs for all cards, close combat, ranged combat, siege, heroes, weather and special cards. Agile units show under both close and ranged combat.

### Privacy
- **Privacy notice:** a *Privacy* link at the bottom of the main menu explains what the game stores and sends.
- **No YouTube without music:** YouTube is only loaded once you turn music on, and it now uses youtube-nocookie.com.

### Fixes
- **Muster:** called cards no longer vanish and reappear at the end of your hand. They now leave from their own slot one at a time, and the deck counter goes down with each card.
- A match no longer stops while dealing the cards when your browser still had parts of an older version of the game cached.

## 1.2.0 (2026-10-08)

Chat with your opponent in online matches. It's on by default; you can turn it off at any time or mute an annoying opponent. Chat isn't filtered, so please try being somewhat respectful.

### Chat
- **Quick chat:** send a preset phrase or emote with the chat button next to your portrait. Phrases appear in each player's own language, so you can greet an opponent who doesn't speak yours.
- **Text chat:** type your own messages in the chat panel on the right. Press **T** to start typing. Collapse the panel when you want it out of the way; a counter shows how many messages you missed.
- **Your choice:** the cog lets you pick no chat, quick chat, or quick chat with text chat. Both are on by default, and your choice is remembered.
- **See your opponent's settings:** the icon next to their portrait shows whether they use quick chat, text chat (marked **Aa**) or no chat at all.
- **Mute:** click your opponent's icon, or use the cog, to hide their messages for the rest of the match.
- **No spam:** after a few messages in a row, chat pauses for a few seconds and shows when it unlocks.

### Quality of life
- **Connection help:** if the game can't reach the server, it now suggests what to try: a private window, turning off ad blockers or VPNs, or another browser.

## 1.1.0 (2026-10-07)

Patch notes are now in the game.

### New
- **Patch notes:** click the version number under the title on the main menu to see what changed in each release.

## 1.0.1 (2026-10-06)

A bug-fix release with more than 50 fixes. The biggest ones: online matches no longer skip turns, desyncs are much rarer, and the computer opponent no longer freezes the game.

### Online play
- **No more skipped turns:** clicking during a card animation could count as a second action and end your opponent's turn, so they were skipped. Only one action per turn is accepted now. This also happened against the computer.
- **Fewer desyncs:** players whose browsers used different languages could end up playing different cards. Skellige's round-3 revive could also desync when Avenger cards like Kambi were involved. The sync check now also compares hands and discard piles.
- **Fair play:** your opponent's moves and deck are now checked against the rules, so cheated or broken moves end the match instead of being accepted.
- **Lobby:** clicking *Ready* repeatedly could start the match out of sync or leave the host stuck on "Starting game". Joining a game the host had just cancelled left the host in a dead lobby, and Quick Match could pair you with yourself on a slow connection.
- **Sturdier server:** a single malformed message could crash the server and end every live game.

### Starting and leaving games
- **Clean new games:** leaving a game by quitting, disconnecting, rematching or starting a new one could leak into the next game, with ghost redraw pickers, skipped turns, old cards on the board or 20-card hands.
- **Card pickers:** a double-click or repeated Enter picked twice and could remove the wrong card. A picker that ran into an error now closes instead of freezing the game.
- Passed and score-leader badges, the opponent's discard pile and the leader slot no longer carry over between games.

### Card rules and abilities
- **Decoy:** no longer gets morale and horn bonuses on the row.
- **Avenger cards:** their tokens stayed in the discard pile, where medics could revive them and Crach an Craite shuffled them back into the deck. They could also be summoned onto the next game's board.
- **King Bran:** his halved weather no longer drops 1-strength units to 0.
- **Northern Realms:** the extra card for winning a round no longer breaks when the deck is empty.
- **Display:** Transformed Vildkaarl descriptions no longer end in "undefined", and the opponent's siege row no longer shows 12 at the start.

### Computer opponent
- **No more freezes:** the computer froze the game with Francesca "Hope" or Eredin "King of the Wild Hunt", crashed with Emhyr "Relentless" when every medic in the discard pile had 0 strength, and could hang on its Skellige round-3 revive.
- **Better decisions:** smarter use of Young Berserker, Francesca "Hope" and Emhyr "Emperor of Nilfgaard", better timing on when to pass, and no more passing on ties in Nilfgaard mirror matches.

### Decks and saved data
- **No more broken saves:** corrupt saved data or blocked browser storage broke the game until you cleared your site data. It now falls back to the defaults.
- **Deck import:** uploaded decks are now saved and properly checked. The "Continue importing deck?" question did the opposite of your answer, and decks over a card's copy limit showed a misleading error.
- The custom opponent deck no longer shows "Random" after a reload.

### Controls
- **Popups and keyboard:** *Resume* in the quit popup could lock the board, keys reached the card picker behind the shortcut legend or a popup, hold-to-pass fired while a card was selected, and Escape skipped a forced row choice. Enter and Escape now close popups, and holding Escape no longer makes the quit popup flicker.
- **Corner buttons:** exit, help, fullscreen and the audio buttons stay clickable while a card picker is open, instead of closing it and ending your redraw.
- The hovered card in your hand no longer jitters when the cursor is between the card and its name label.

### Languages and layout
- **Arabic:** text is now laid out right to left, without mirroring the board.
- **Translations:** import warnings and the Scoia'tael go-first popup are now translated into every language. Translated labels like *Pass*, *Passed*, deck builder stats and leader names now fit their space, and tooltips no longer run off the screen.
- **Language selector:** shown only on the main menu, because switching language reloads the page and dropped your hosted room or Quick Match search.
- **Screen fit:** the board scales down on desktop windows too short to show the Pass button, is centered on 4:3 and 3:2 screens, and lobby text stays readable on 32:9 monitors.
- The Scoia'tael go-first message has an icon, and the fullscreen button's icon and tooltip stay correct.

### Music
- **Reliable music button:** clicks while the music was loading could leave it stuck, and after changing language the button could no longer start music. The button also keeps working when YouTube is blocked, and music no longer blips on load when it's turned off.

## 1.0.0 (2026-07-19)

The first numbered release of Gwent Classic Multiplayer.

### Play online
- **Quick Match:** press *Find Opponent* to be paired with the next player who searches. While you wait, the screen shows how many other players are online.
- **Play a friend:** press *Create Game* to get a 5-letter room code to share. Your friend enters it with *Join Game*.
- Each player builds a deck and presses *Ready*. After the match, ready up again for a rematch.
- If your opponent leaves or disconnects, you're told straight away and returned to the menu.

### Your language
- Play in 17 languages: English, Polish, Russian, Czech, Hungarian, German, French, Italian, Brazilian Portuguese, Spanish, Latin American Spanish, Turkish, Simplified Chinese, Traditional Chinese, Japanese, Korean and Arabic.
- All 185 card names use the official translations from The Witcher 3 itself.
- The game picks your browser's language automatically. You can change it with the globe button on the main menu.

### Quality of life
- **New main menu:** the game now opens on a start screen where you pick *vs Computer* or *vs Player*, with styled screens for creating and joining online games.
- **Fits your screen:** the board scales to ultrawide monitors and smaller screens, including phones, and no longer turns sideways on a phone held upright. Fullscreen buttons are on the menu and in matches.
- **Keyboard controls:** play cards, use your leader, back out of a choice and pass the round without touching the mouse. Press **?** in a match to see every shortcut.
- **Smoother redraw:** scroll or swipe through your cards, and you're told while your opponent is still redrawing.
- **Card descriptions:** a close button hides them so you can see the cards behind.
- **Quieter start:** music and sound start muted, and the audio buttons are also available in the online lobby.
- **Feedback button:** report a bug or suggest an idea straight from the game.

### Fixes and polish
27 bug fixes, mostly screen layout, menus and keyboard controls, plus a few card abilities, and a sturdier game server.

### Credits
- **CD PROJEKT RED**: for creating *The Witcher 3: Wild Hunt* and *Gwent*. All card art, names and the game itself are theirs. This is a non-commercial fan project and is not affiliated with CDPR.
- **[Arun Sundaram](https://github.com/asundr/gwent-classic)**: for the original browser remake this project is built on.
- **[RandomPianist](https://github.com/RandomPianist/gwent-classic-v3.1)**: for sound effects used in Arun's original version.
