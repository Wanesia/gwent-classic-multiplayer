"use strict"

// Opt-in quick chat for online matches. Only preset ids travel over the wire
// ({t:"chat", q:id}), so each player reads them in their own language and
// nothing free-form can reach the opponent.

// Rate limiter: `size` messages at once, then one more every `refillMs`
class TokenBucket {
	constructor(size, refillMs) {
		this.size = size;
		this.refillMs = refillMs;
		this.reset();
	}

	reset() {
		this.tokens = this.size;
		this.last = performance.now();
	}

	refill() {
		const now = performance.now();
		this.tokens = Math.min(this.size, this.tokens + (now - this.last) / this.refillMs);
		this.last = now;
	}

	take() {
		this.refill();
		if (this.tokens < 1)
			return false;
		this.tokens -= 1;
		return true;
	}

	msUntilNext() {
		this.refill();
		return this.tokens >= 1 ? 0 : Math.ceil((1 - this.tokens) * this.refillMs);
	}
}

var QuickChat = {
	EMOTES: { wave: "👋", thumbsUp: "👍", laugh: "😄", wow: "😮", think: "🤔", sad: "😢" },
	PHRASES: ["hello", "goodLuck", "goodMove", "watchThis", "oops", "goodGame", "thanks", "bye"],
	EMOTE_MS: 3000,
	PHRASE_MS: 4500,
	HOVER_CLOSE_MS: 700,

	// The receiving side is a little more lenient so network jitter that
	// bunches up honest messages doesn't drop them
	sendBucket: new TokenBucket(3, 4000),
	recvBucket: new TokenBucket(4, 3000),
	timers: {},
	pinned: false,

	init() {
		this.layer = document.getElementById("chat-layer");
		this.button = document.getElementById("chat-button");
		this.picker = document.getElementById("chat-picker");
		this.opState = document.getElementById("chat-op-state");
		this.bubbles = { me: document.getElementById("chat-bubble-me"), op: document.getElementById("chat-bubble-op") };
		this.buildPicker();

		// Keep focus on the game: a focused chat button would also fire on the
		// Enter/Space keys used to play cards
		this.layer.addEventListener("mousedown", e => e.preventDefault());

		const canHover = matchMedia("(hover: hover) and (pointer: fine)").matches;
		if (canHover) {
			for (const el of [this.button, this.picker]) {
				el.addEventListener("mouseenter", () => this.openPicker());
				el.addEventListener("mouseleave", () => this.scheduleClose());
			}
		}
		// A click pins the picker open until the next click outside, Escape or a send
		this.button.addEventListener("click", e => {
			e.stopPropagation();
			if (this.pinned) {
				this.closePicker();
			} else {
				this.openPicker();
				this.pinned = this.isOpen();
			}
		});
		document.addEventListener("pointerdown", e => {
			if (this.isOpen() && !this.button.contains(e.target) && !this.isInsidePicker(e))
				this.closePicker();
		});
		// Capture phase so Escape closes the picker without also cancelling a
		// card selection underneath
		window.addEventListener("keydown", e => {
			if (e.key === "Escape" && this.isOpen()) {
				e.stopImmediatePropagation();
				this.closePicker();
			}
		}, true);
	},

	buildPicker() {
		const emotes = document.createElement("div");
		emotes.className = "chat-emotes";
		const phrases = document.createElement("div");
		phrases.className = "chat-phrases";
		let i = 0;
		const add = (parent, id, label) => {
			const b = document.createElement("button");
			b.type = "button";
			b.tabIndex = -1;
			b.className = "chat-option";
			b.dataset.chat = id;
			b.textContent = label;
			b.style.setProperty("--i", i++);
			b.addEventListener("click", e => {
				e.stopPropagation();
				this.send(id);
			});
			parent.appendChild(b);
		};
		for (const id in this.EMOTES)
			add(emotes, id, this.EMOTES[id]);
		for (const id of this.PHRASES)
			add(phrases, id, I18N.t("chat." + id));
		this.cooldownNote = document.createElement("div");
		this.cooldownNote.id = "chat-cooldown-note";
		this.picker.append(emotes, phrases, this.cooldownNote);
	},

	// The picker's invisible hover margin counts as outside for clicks
	isInsidePicker(e) {
		if (!this.picker.contains(e.target))
			return false;
		const r = this.picker.getBoundingClientRect();
		return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
	},

	// Online match, chat switched on, and an opponent whose client knows the
	// "chat" message (an older one would treat it as a desync)
	available() {
		return mp.active && Settings.quickChat.isEnabled() && lobby.peerChat;
	},

	// New match: fresh rate limits, then show or hide the chat UI
	reset() {
		this.sendBucket.reset();
		this.recvBucket.reset();
		this.refresh();
	},

	refresh() {
		const on = this.available();
		this.layer.classList.toggle("hide", !on);
		if (!on) {
			this.closePicker();
			this.hideBubble("me");
			this.hideBubble("op");
		}
		this.updatePeerState();
		this.updateCooldown();
	},

	send(id) {
		if (!this.available() || !this.sendBucket.take())
			return;
		mp.send({ t: "chat", q: id });
		this.closePicker();
		this.show("me", id);
		this.updateCooldown();
	},

	// The peer is untrusted: only known ids, at a bounded rate
	receive(msg) {
		if (!this.available() || !this.isKnown(msg.q) || !this.recvBucket.take())
			return;
		this.show("op", msg.q);
	},

	// {t:"chat-state", on}: the opponent switched their quick chat on or off
	receiveState(msg) {
		if (typeof msg.on !== "boolean")
			return;
		lobby.peerChatOn = msg.on;
		this.updatePeerState();
	},

	updatePeerState() {
		const on = lobby.peerChatOn === true;
		this.opState.classList.toggle("off", !on);
		this.opState.setAttribute("data-title", I18N.t(on ? "chat.opponentOn" : "chat.opponentOff"));
	},

	isKnown(id) {
		return typeof id === "string" && (Object.hasOwn(this.EMOTES, id) || this.PHRASES.includes(id));
	},

	show(who, id) {
		const bubble = this.bubbles[who];
		const emote = Object.hasOwn(this.EMOTES, id);
		const ms = emote ? this.EMOTE_MS : this.PHRASE_MS;
		bubble.textContent = emote ? this.EMOTES[id] : I18N.t("chat." + id);
		bubble.classList.toggle("chat-emote", emote);
		bubble.style.setProperty("--chat-ms", ms + "ms");
		// Restart the animation when a new message replaces the current one
		bubble.classList.remove("show");
		void bubble.offsetWidth;
		bubble.classList.add("show");
		clearTimeout(this.timers[who]);
		this.timers[who] = setTimeout(() => this.hideBubble(who), ms);
	},

	hideBubble(who) {
		clearTimeout(this.timers[who]);
		this.bubbles[who].classList.remove("show");
	},

	isOpen() {
		return this.picker.classList.contains("open");
	},

	openPicker() {
		clearTimeout(this.closeTimer);
		if (!this.available())
			return;
		this.updateCooldown();
		this.hideBubble("me");
		this.picker.classList.add("open");
		this.button.classList.add("active");
	},

	closePicker() {
		clearTimeout(this.closeTimer);
		this.pinned = false;
		this.picker.classList.remove("open");
		this.button.classList.remove("active");
	},

	scheduleClose() {
		clearTimeout(this.closeTimer);
		if (this.pinned)
			return;
		this.closeTimer = setTimeout(() => this.closePicker(), this.HOVER_CLOSE_MS);
	},

	// Disables the options while the send bucket is empty, with a per-second countdown
	updateCooldown() {
		clearTimeout(this.cooldownTimer);
		const wait = this.sendBucket.msUntilNext();
		const s = Math.ceil(wait / 1000);
		this.layer.classList.toggle("chat-cooldown", wait > 0);
		this.cooldownNote.textContent = wait > 0 ? I18N.t("chat.cooldown", { s }) : "";
		this.button.setAttribute("data-title", wait > 0 ? I18N.t("chat.openCooldown", { s }) : I18N.t("chat.open"));
		if (wait > 0) {
			this.button.dataset.cooldown = s;
			this.cooldownTimer = setTimeout(() => this.updateCooldown(), wait % 1000 || 1000);
		} else {
			delete this.button.dataset.cooldown;
		}
	}
};

QuickChat.init();
