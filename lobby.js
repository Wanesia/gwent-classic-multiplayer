"use strict"

// Pre-game menu and online lobby. Shows the mode choice (Vs Computer /
// Vs Player) on startup, handles room create/join against the relay server,
// and runs the ready-up phase in the deck builder before handing the match
// off to the multiplayer session (mp in netplay.js).
//
// Match start is host-driven to avoid ready/unready races: when the host sees
// both players ready it sends lobby-start with the RNG seed; the guest acks
// and starts, and the host starts on the ack.
class Lobby {
	constructor() {
		this.elem = document.getElementById("lobby");
		this.statusElem = document.getElementById("mp-status");
		this.statusText = document.getElementById("mp-opponent-state");
		this.startButton = document.getElementById("start-game");
		this.codeElem = document.getElementById("room-code");
		this.copyHint = document.getElementById("copy-hint");
		this.createStatus = document.getElementById("create-status");
		this.searchStatus = document.getElementById("search-status");
		this.searchHint = document.getElementById("search-hint");
		this.searchOnline = document.getElementById("search-online");
		this.joinError = document.getElementById("join-error");
		this.joinInput = document.getElementById("join-code");
		this.joinSubtitle = document.getElementById("join-subtitle");

		this.inMultiplayer = false;
		this.localReady = false;
		this.remoteReady = false;
		this.remoteCustomizing = false;
		this.starting = false;
		this.remoteDeckRaw = null;
		this.pendingSeed = null;
		this.searchHintTimer = null;
		this.searchHintDelay = 75000; // "no one's around" fallback while searching

		document.getElementById("split-computer").addEventListener("click", () => this.startSinglePlayer());
		document.getElementById("split-player").addEventListener("click", () => { Net.trackEvent("mode-mp"); this.showView("lobby-mp"); });
		document.getElementById("lobby-quick-button").addEventListener("click", () => this.findOpponent());
		document.getElementById("lobby-create-button").addEventListener("click", () => this.createGame());
		document.getElementById("lobby-join-button").addEventListener("click", () => this.showJoin());
		document.getElementById("join-button").addEventListener("click", () => this.joinGame());
		document.getElementById("lobby-return").addEventListener("click", () => this.returnToMenu());
		this.codeElem.addEventListener("click", () => this.copyCode());
		this.joinInput.addEventListener("keydown", e => {
			if (e.key === "Enter")
				this.joinGame();
		});
		this.joinInput.addEventListener("input", () => {
			if (this.joinInput.value.trim().length === 5)
				this.joinGame();
		});
		[...this.elem.getElementsByClassName("lobby-back")].forEach(b =>
			b.addEventListener("click", () => this.goBack(b.getAttribute("data-target"))));
		addMouseEnterSFXBySelector(".mp-option");
		addMouseEnterSFXBySelector(".split-panel");

		Net.onPeerJoined = () => this.enterDeckSetup();
		Net.onPeerLeft = () => this.handlePeerLeft();
		EventManager.customizationOpened.bind(() => this.onCustomizationOpened());
	}

	showView(id) {
		[...this.elem.getElementsByClassName("lobby-view")].forEach(v =>
			v.classList.toggle("hide", v.id !== id));
	}

	showMenu() {
		this.elem.classList.remove("hide");
		this.showView("lobby-mode");
		ui.toggleSettings.forEach(e => e.classList.add('lobby-menu'));
	}

	goBack(target) {
		this.stopSearchExtras();
		if (Net.code)
			Net.leave(); // cancel a room we created and are waiting in
		this.showView(target || "lobby-mode");
	}

	startSinglePlayer() {
		Net.trackEvent("mode-sp");
		AudioManager.playSFX("menu_opening");
		this.statusText.textContent = "vs Computer";
		this.statusElem.classList.remove("hide");
		this.elem.classList.add("hide");
		ui.toggleSettings.forEach(e => e.classList.remove('lobby-menu'));
	}

	returnToMenu() {
		AudioManager.playSFX("menu_opening");
		if (this.inMultiplayer) {
			Net.leave();
			this.exitMultiplayer();
		} else {
			this.statusElem.classList.add("hide");
			this.showMenu();
		}
	}

	showJoin() {
		this.joinError.textContent = "";
		this.joinInput.value = "";
		this.showView("lobby-join");
		this.joinInput.focus();
		this._joinReady = false;
		requestAnimationFrame(() => this._joinReady = true);
	}

	// Quick match
	async findOpponent() {
		Net.trackEvent("mode-qm");
		this.showView("lobby-search");
		this.searchHint.textContent = "You'll be matched with the next player who searches.";
		this.searchOnline.textContent = "";
		this.searchStatus.textContent = "Connecting to server";
		this.searchStatus.classList.remove("is-waiting");
		Net.onQmStatus = n => this.showOnlineCount(n);
		try {
			await Net.connect();
			await Net.quickMatch();
			if (Net.role === "guest") {
				this.enterDeckSetup();
			} else {
				this.searchStatus.textContent = "Searching for an opponent";
				this.searchStatus.classList.add("is-waiting");
				this.searchHintTimer = setTimeout(() => {
					this.searchHint.textContent = "No one's around right now. Keep waiting, invite a friend with a code, or play vs Computer.";
				}, this.searchHintDelay);
			}
		} catch (e) {
			this.stopSearchExtras();
			this.searchStatus.textContent = this.errorText(e.message);
			this.searchStatus.classList.remove("is-waiting");
		}
	}

	showOnlineCount(online) {
		const others = Math.max(0, online - 1);
		this.searchOnline.textContent = others === 0 ? "No other players online right now" :
			others === 1 ? "1 other player online" : others + " other players online";
	}

	stopSearchExtras() {
		clearTimeout(this.searchHintTimer);
		this.searchHintTimer = null;
		Net.onQmStatus = null;
	}

	async createGame() {
		this.showView("lobby-create");
		this.codeElem.textContent = "·····";
		this.copyHint.textContent = "";
		this.createStatus.textContent = "Connecting to server";
		this.createStatus.classList.remove("is-waiting");
		try {
			await Net.connect();
			const code = await Net.createRoom();
			this.codeElem.textContent = code;
			this.copyHint.textContent = "Click the code to copy it";
			this.createStatus.textContent = "Waiting for opponent";
			this.createStatus.classList.add("is-waiting");
		} catch (e) {
			this.createStatus.textContent = this.errorText(e.message);
			this.createStatus.classList.remove("is-waiting");
		}
	}

	async joinGame() {
		const code = this.joinInput.value.trim().toUpperCase();
		if (code.length === 0) {
			if (this._joinReady) {
				this.joinSubtitle.classList.remove("shake");
				void this.joinSubtitle.offsetWidth;
				this.joinSubtitle.classList.add("shake");
			}
			return;
		}
		this.joinError.textContent = "";
		try {
			await Net.connect();
			await Net.joinRoom(code);
			this.enterDeckSetup();
		} catch (e) {
			this.joinError.textContent = this.errorText(e.message);
		}
	}

	errorText(code) {
		switch (code) {
			case "unreachable": return "Could not reach the game server.";
			case "not-found": return "Game not found. Check the code and try again.";
			case "full": return "That game already has two players.";
			default: return "Something went wrong (" + code + ").";
		}
	}

	copyCode() {
		const code = this.codeElem.textContent;
		if (!Net.code || code !== Net.code)
			return;
		const confirm = () => {
			this.copyHint.textContent = "Copied!";
			setTimeout(() => this.copyHint.textContent = "Click the code to copy it", 1500);
		};
		if (navigator.clipboard) {
			navigator.clipboard.writeText(code).then(confirm).catch(() => this.copyCodeFallback(code, confirm));
		} else {
			this.copyCodeFallback(code, confirm);
		}
	}

	copyCodeFallback(code, confirm) {
		const area = document.createElement("textarea");
		area.value = code;
		document.body.appendChild(area);
		area.select();
		try {
			if (document.execCommand("copy"))
				confirm();
		} finally {
			document.body.removeChild(area);
		}
	}

	// Both players are connected: drop into the deck builder in ready-up mode
	enterDeckSetup() {
		this.stopSearchExtras();
		this.inMultiplayer = true;
		this.localReady = false;
		this.remoteReady = false;
		this.remoteCustomizing = false;
		this.starting = false;
		this.remoteDeckRaw = null;
		this.pendingSeed = null;
		Net.onMessage = m => this.routeLobby(m);
		this.elem.classList.add("hide");
		ui.toggleSettings.forEach(e => e.classList.remove('lobby-menu'));
		this.statusElem.classList.remove("hide");
		document.getElementById("opponent-preview").classList.add("hide");
		this.startButton.textContent = "Ready";
		this.updateStatus();
		AudioManager.playSFX("menu_opening");
	}

	// Called by DeckMaker.startNewGame in multiplayer mode, after the local
	// deck has passed validation
	toggleReady() {
		if (this.starting)
			return;
		if (!this.localReady) {
			this.localReady = true;
			Net.send({ t: "lobby-ready", deck: JSON.parse(dm.deckToJSON()) });
			this.startButton.textContent = "Cancel";
			dm.elem.classList.add("mp-locked");
			this.checkStart();
		} else {
			this.localReady = false;
			Net.send({ t: "lobby-unready" });
			this.startButton.textContent = "Ready";
			dm.elem.classList.remove("mp-locked");
		}
		this.updateStatus();
	}

	routeLobby(m) {
		switch (m.t) {
			case "lobby-ready":
				this.remoteReady = true;
				this.remoteCustomizing = false;
				this.remoteDeckRaw = m.deck;
				this.updateStatus();
				this.checkStart();
				break;
			case "lobby-unready":
				this.remoteReady = false;
				this.remoteCustomizing = false;
				this.remoteDeckRaw = null;
				this.starting = false;
				this.pendingSeed = null;
				this.updateStatus();
				break;
			case "lobby-customizing":
				// Peer left the end screen to edit their deck; still connected
				this.remoteReady = false;
				this.remoteCustomizing = true;
				this.remoteDeckRaw = null;
				this.starting = false;
				this.pendingSeed = null;
				this.updateStatus();
				break;
			case "lobby-start":
				if (Net.role !== "guest")
					break;
				if (!this.localReady) {
					Net.send({ t: "lobby-unready" });
					break;
				}
				Net.send({ t: "lobby-start-ack" });
				this.beginMatch(m.seed);
				break;
			case "lobby-start-ack":
				if (this.starting && this.pendingSeed !== null)
					this.beginMatch(this.pendingSeed);
				break;
		}
	}

	checkStart() {
		if (this.localReady && this.remoteReady && !this.starting)
			this.initiateStart();
	}

	initiateStart() {
		if (Net.role !== "host")
			return; // the guest waits for the host's lobby-start
		this.starting = true;
		this.pendingSeed = GameRNG.randomSeed();
		Net.send({ t: "lobby-start", seed: this.pendingSeed });
		this.updateStatus("Starting game...");
	}

	beginMatch(seed) {
		const localRaw = JSON.parse(dm.deckToJSON());
		const remoteRaw = this.remoteDeckRaw;
		// A rematch starts straight from the end screen: clear the finished game
		// and hide the scoreboard before the fresh match spins up.
		if (game.state === GameState.END_SCREEN) {
			game.reset();
			game.endScreen.classList.add("hide");
		}
		this.resetReadyState();
		mp.startMatch(seed, localRaw, remoteRaw);
	}

	resetReadyState() {
		this.localReady = false;
		this.remoteReady = false;
		this.remoteCustomizing = false;
		this.starting = false;
		this.remoteDeckRaw = null;
		this.pendingSeed = null;
		this.startButton.textContent = "Ready";
		dm.elem.classList.remove("mp-locked");
		this.updateStatus();
	}

	updateStatus(text) {
		if (text === undefined)
			text = "Opponent: " + (this.remoteReady ? "ready" : "connected") +
				(this.localReady && !this.remoteReady ? " — waiting for them to ready up" : "");
		this.statusText.textContent = text;
		// The same ready-up state drives the end-screen "Play Again" button
		if (game.state === GameState.END_SCREEN)
			game.updateRematchButton();
	}

	// End-screen "Play Again": ready up for a rematch with the current decks,
	// reusing the lobby ready/start handshake. When both players have asked, the
	// host drives the restart (lobby-start) exactly as a first match would.
	toggleRematch() {
		if (this.starting)
			return;
		if (!this.localReady) {
			this.localReady = true;
			Net.send({ t: "lobby-ready", deck: JSON.parse(dm.deckToJSON()) });
			this.checkStart();
		} else {
			this.localReady = false;
			Net.send({ t: "lobby-unready" });
		}
		game.updateRematchButton();
	}

	// End-screen "Leave": disconnect from the room and return to the main menu.
	leaveFromEndScreen() {
		if (!this.inMultiplayer)
			return;
		AudioManager.playSFX("menu_opening");
		this.inMultiplayer = false;
		mp.deactivate();
		Net.leave();
		if (game.state !== GameState.CUSTOMIZE)
			game.returnToCustomization();
		this.exitMultiplayer();
	}

	// The local player returned to the deck builder while an online match was
	// still live: either the match ended normally (END_SCREEN, stay connected
	// for a rematch) or they quit mid-game (abandon the room)
	onCustomizationOpened() {
		if (!this.inMultiplayer || !mp.active)
			return;
		mp.deactivate();
		Net.onMessage = m => this.routeLobby(m);
		if (game.state === GameState.PLAYING) {
			Net.leave();
			this.exitMultiplayer();
		} else {
			// Left the end screen to edit the deck: stay connected, but let the
			// peer's Play Again status know we're customizing rather than ready
			this.localReady = false;
			Net.send({ t: "lobby-customizing" });
		}
	}

	handlePeerLeft() {
		if (this.inMultiplayer) {
			this.endMultiplayerGame("Opponent Disconnected", "Your opponent has left the game.");
		} else if (!this.elem.classList.contains("hide")) {
			// connection or room died while waiting in the create or search view
			this.stopSearchExtras();
			for (const status of [this.createStatus, this.searchStatus]) {
				status.textContent = this.errorText("unreachable");
				status.classList.remove("is-waiting");
			}
		}
	}

	// Ends an online session from any phase with a notice, then returns to the
	// main menu. Used for disconnects and desyncs.
	endMultiplayerGame(title, description) {
		if (!this.inMultiplayer)
			return;
		this.inMultiplayer = false;
		mp.deactivate();
		Net.leave();
		AudioManager.playSFX("warning");
		ui.popup("Return to Menu", () => {
			if (game.state !== GameState.CUSTOMIZE)
				game.returnToCustomization();
			this.exitMultiplayer();
		}, null, null, title, description);
	}

	// The match could not start (e.g. the opponent's deck failed validation)
	matchFailed(description) {
		Net.onMessage = m => this.routeLobby(m);
		AudioManager.playSFX("warning");
		ui.popup("OK", () => {}, null, null, "Could Not Start Game",
			description + " If this keeps happening, your versions of the game may differ.");
	}

	// Restores the single-player deck builder UI and shows the main menu
	exitMultiplayer() {
		this.inMultiplayer = false;
		this.localReady = false;
		this.remoteReady = false;
		this.remoteCustomizing = false;
		this.starting = false;
		this.remoteDeckRaw = null;
		this.pendingSeed = null;
		Net.onMessage = null;
		this.statusElem.classList.add("hide");
		document.getElementById("opponent-preview").classList.remove("hide");
		this.startButton.textContent = "Start game";
		dm.elem.classList.remove("mp-locked");
		this.showMenu();
	}
}

var lobby = new Lobby();
ui.toggleSettings.forEach(e => e.classList.add('lobby-menu'));
