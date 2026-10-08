"use strict"

// Opt-in chat for online matches, outside the lockstep. Quick chat sends only
// preset ids ({t:"chat", q:id}), so each player reads them in their own
// language. Text chat ({t:"chat-text", s}) carries free text, sanitized on
// both ends and only ever rendered as plain text.

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

const CHAT_MAX_CHARS = 120;

// One visible line of at most CHAT_MAX_CHARS code points, or "" if nothing is left
function sanitizeChatText(s) {
	if (typeof s !== "string")
		return "";
	s = s.normalize("NFC")
		.replace(/\p{Cc}/gu, " ")
		// format characters (bidi controls, BOM...) except the joiners emoji and scripts need,
		// lone surrogates and blank fillers
		.replace(/(?![\u200C\u200D])[\p{Cf}\p{Cs}ᅟᅠㅤﾠ⠀]/gu, "")
		// stacked combining marks would draw over the lines around them
		.replace(/(\p{M}{4})\p{M}+/gu, "$1")
		.replace(/\s+/gu, " ")
		.trim();
	const chars = Array.from(s);
	if (chars.length > CHAT_MAX_CHARS)
		s = chars.slice(0, CHAT_MAX_CHARS).join("").trim();
	return s;
}

var QuickChat = {
	EMOTES: { wave: "👋", cool: "😎", laugh: "😄", wow: "😮", think: "🤔", sad: "😢" },
	PHRASES: ["hello", "goodLuck", "goodMove", "watchThis", "oops", "goodGame", "thanks", "bye"],
	EMOTE_MS: 3000,
	PHRASE_MS: 4500,
	HOVER_CLOSE_MS: 700,

	// Quick and text messages share these: spam is spam. The receiving side
	// is a little more lenient so network jitter that bunches up honest
	// messages doesn't drop them.
	sendBucket: new TokenBucket(3, 4000),
	recvBucket: new TokenBucket(4, 3000),
	timers: {},
	pinned: false,
	muted: false, // this opponent, for this match only

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
		this.opState.addEventListener("click", () => this.setMuted(!this.muted));
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

	// Online match with an opponent whose client knows the chat messages (an
	// older one would treat them as a desync)
	online() {
		return mp.active && lobby.peerChat;
	},

	quickOn() {
		return this.online() && Settings.quickChat.isEnabled();
	},

	// Text chat is an add-on to quick chat
	textOn() {
		return this.quickOn() && Settings.textChat.isEnabled();
	},

	// New match: fresh rate limits, no mute, empty log, then show or hide the chat UI
	reset() {
		this.sendBucket.reset();
		this.recvBucket.reset();
		this.muted = false;
		ChatLog.clear();
		this.refresh();
	},

	refresh() {
		const quick = this.quickOn();
		this.layer.classList.toggle("hide", !quick);
		this.button.classList.toggle("hide", !quick);
		this.button.classList.toggle("text", this.textOn());
		if (!quick)
			this.closePicker();
		if (!this.online()) {
			this.hideBubble("me");
			this.hideBubble("op");
		}
		ChatLog.refresh();
		ChatSettings.render();
		this.updatePeerState();
		this.updateCooldown();
	},

	// Every chat message type, routed here before the lockstep queue.
	// Unknown chat types are dropped so newer clients can add some.
	route(msg) {
		if (msg.t === "chat")
			this.receive(msg);
		else if (msg.t === "chat-text")
			this.receiveText(msg);
		else if (msg.t === "chat-state")
			this.receiveState(msg);
	},

	send(id) {
		if (!this.quickOn() || !this.sendBucket.take())
			return;
		mp.send({ t: "chat", q: id });
		this.closePicker();
		this.show("me", id);
		ChatLog.add("me", this.label(id));
		this.updateCooldown();
	},

	// False if nothing was sent (empty, cooling down, or the opponent can't read it)
	sendText(raw) {
		const s = sanitizeChatText(raw);
		if (!s || !this.textOn() || !lobby.peerChatText)
			return false;
		if (!this.sendBucket.take()) {
			this.updateCooldown();
			return false;
		}
		mp.send({ t: "chat-text", s });
		this.showText("me", s);
		ChatLog.add("me", s);
		this.updateCooldown();
		return true;
	},

	// The peer is untrusted: only known ids, at a bounded rate
	receive(msg) {
		if (!this.quickOn() || this.muted || !this.isKnown(msg.q) || !this.recvBucket.take())
			return;
		this.show("op", msg.q);
		ChatLog.add("op", this.label(msg.q));
	},

	receiveText(msg) {
		if (!this.textOn() || this.muted)
			return;
		const s = sanitizeChatText(msg.s);
		if (!s || !this.recvBucket.take())
			return;
		this.showText("op", s);
		ChatLog.add("op", s);
	},

	// {t:"chat-state", quick, text}: the opponent changed their chat settings
	receiveState(msg) {
		if (typeof msg.quick !== "boolean" || typeof msg.text !== "boolean")
			return;
		lobby.peerChatQuick = msg.quick;
		lobby.peerChatText = msg.text;
		this.updatePeerState();
	},

	setMuted(muted) {
		if (!mp.active)
			return;
		this.muted = muted;
		if (muted)
			this.hideBubble("op");
		this.updatePeerState();
		ChatSettings.render();
	},

	updatePeerState() {
		const quick = lobby.peerChatQuick === true;
		const text = lobby.peerChatText === true;
		this.opState.classList.toggle("off", !quick && !text);
		this.opState.classList.toggle("text", text);
		this.opState.classList.toggle("muted", this.muted);
		const state = I18N.t("chat.opponentState", {
			quick: I18N.t(quick ? "chat.opQuickOn" : "chat.opQuickOff"),
			text: I18N.t(text ? "chat.opTextOn" : "chat.opTextOff")
		});
		this.opState.setAttribute("data-title", this.muted ? I18N.t("chat.opponentMuted") : state);
		ChatLog.updateInput();
	},

	isKnown(id) {
		return typeof id === "string" && (Object.hasOwn(this.EMOTES, id) || this.PHRASES.includes(id));
	},

	label(id) {
		return Object.hasOwn(this.EMOTES, id) ? this.EMOTES[id] : I18N.t("chat." + id);
	},

	show(who, id) {
		const emote = Object.hasOwn(this.EMOTES, id);
		this.display(who, this.label(id), emote, emote ? this.EMOTE_MS : this.PHRASE_MS);
	},

	// Longer messages stay up longer
	showText(who, s) {
		this.display(who, s, false, Math.min(9000, 4000 + 50 * Array.from(s).length));
	},

	display(who, text, emote, ms) {
		const bubble = this.bubbles[who];
		bubble.textContent = text;
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
		if (!this.quickOn())
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

	// Disables sending while the send bucket is empty, with a per-second countdown
	updateCooldown() {
		clearTimeout(this.cooldownTimer);
		const wait = this.sendBucket.msUntilNext();
		const s = Math.ceil(wait / 1000);
		this.layer.classList.toggle("chat-cooldown", wait > 0);
		this.cooldownNote.textContent = wait > 0 ? I18N.t("chat.cooldown", { s }) : "";
		this.button.setAttribute("data-title", wait > 0 ? I18N.t("chat.openCooldown", { s }) : I18N.t("chat.open"));
		ChatLog.setCooldown(wait > 0 ? I18N.t("chat.cooldown", { s }) : "");
		if (wait > 0) {
			this.button.dataset.cooldown = s;
			this.cooldownTimer = setTimeout(() => this.updateCooldown(), wait % 1000 || 1000);
		} else {
			delete this.button.dataset.cooldown;
		}
	}
};

// Text chat panel in the right panel: both sides' messages and the input
var ChatLog = {
	MAX_ENTRIES: 50,
	COLLAPSED_KEY: "gc-chat-log-collapsed",
	unread: 0,

	init() {
		this.elem = document.getElementById("chat-log");
		this.list = document.getElementById("chat-log-list");
		this.input = document.getElementById("chat-input");
		this.note = document.getElementById("chat-log-note");
		this.badge = document.getElementById("chat-log-unread");
		this.head = document.getElementById("chat-log-head");
		this.input.placeholder = I18N.t("chat.placeholder");
		this.collapsed = safeStorage.get(this.COLLAPSED_KEY) === "true";
		this.elem.classList.toggle("collapsed", this.collapsed);

		this.head.addEventListener("mousedown", e => e.preventDefault());
		this.head.addEventListener("click", () => this.setCollapsed(!this.collapsed));
		this.input.addEventListener("keydown", e => {
			// Typing must never reach the game's or a carousel's shortcuts
			e.stopPropagation();
			if (e.key === "Enter" && !e.isComposing) {
				e.preventDefault();
				if (QuickChat.sendText(this.input.value))
					this.input.value = "";
			} else if (e.key === "Escape") {
				e.preventDefault();
				this.input.blur();
			}
		});
		this.input.addEventListener("keyup", e => e.stopPropagation());
		this.input.addEventListener("input", e => {
			if (e.isComposing)
				return;
			const chars = Array.from(this.input.value);
			if (chars.length > CHAT_MAX_CHARS)
				this.input.value = chars.slice(0, CHAT_MAX_CHARS).join("");
		});
		this.updateTitle();
	},

	refresh() {
		const on = QuickChat.textOn();
		this.elem.classList.toggle("hide", !on);
		if (!on)
			this.input.blur();
		this.updateInput();
	},

	clear() {
		this.list.replaceChildren();
		this.setUnread(0);
	},

	add(who, text) {
		if (!QuickChat.textOn())
			return;
		const atBottom = this.list.scrollTop + this.list.clientHeight >= this.list.scrollHeight - 4;
		const entry = document.createElement("div");
		entry.className = "chat-entry chat-entry-" + who;
		entry.dir = "auto"; // follows the label's script, so Arabic lines read right to left
		const name = document.createElement("span");
		name.className = "chat-entry-who";
		name.textContent = I18N.t(who === "me" ? "game.you" : "game.opponent");
		const body = document.createElement("span");
		body.className = "chat-entry-text";
		body.dir = "auto";
		body.textContent = text;
		entry.append(name, " ", body);
		this.list.appendChild(entry);
		while (this.list.childElementCount > this.MAX_ENTRIES)
			this.list.firstElementChild.remove();
		if (atBottom || who === "me")
			this.list.scrollTop = this.list.scrollHeight;
		if (who === "op" && this.collapsed)
			this.setUnread(this.unread + 1);
	},

	setUnread(n) {
		this.unread = n;
		this.badge.textContent = n > 99 ? "99+" : String(n);
		this.badge.classList.toggle("hide", n === 0);
	},

	setCollapsed(collapsed) {
		this.collapsed = collapsed;
		safeStorage.set(this.COLLAPSED_KEY, collapsed);
		this.elem.classList.toggle("collapsed", collapsed);
		this.updateTitle();
		if (collapsed) {
			this.input.blur();
		} else {
			this.setUnread(0);
			this.list.scrollTop = this.list.scrollHeight;
		}
	},

	// T shortcut: true if the input took focus
	focusInput() {
		if (!QuickChat.textOn() || Carousel.curr || Popup.curr || this.input.disabled)
			return false;
		if (this.collapsed)
			this.setCollapsed(false);
		this.input.focus();
		return true;
	},

	// Replaced by a notice while the opponent can't read text messages
	updateInput() {
		const peerOff = lobby.peerChatText !== true;
		if (peerOff)
			this.input.blur();
		this.input.disabled = peerOff;
		this.elem.classList.toggle("peer-off", peerOff);
	},

	updateTitle() {
		this.head.setAttribute("data-title", I18N.t(this.collapsed ? "chat.showLog" : "chat.hideLog"));
	},

	setCooldown(text) {
		this.note.textContent = text;
		this.elem.classList.toggle("chat-cooldown", text !== "");
	}
};

// Chat settings popover on the cog in the settings cluster
var ChatSettings = {
	init() {
		this.button = document.getElementById("toggle-chat-settings");
		this.panel = document.getElementById("chat-settings");
		this.switches = [...this.panel.querySelectorAll(".chat-switch")];
		this.enforceTextNeedsQuick();
		this.panel.addEventListener("mousedown", e => e.preventDefault());
		this.button.addEventListener("click", e => {
			if (!this.panel.contains(e.target))
				this.isOpen() ? this.close() : this.open();
		});
		for (const sw of this.switches)
			sw.addEventListener("click", () => this.toggle(sw.dataset.setting));
		document.addEventListener("pointerdown", e => {
			if (this.isOpen() && !this.button.contains(e.target))
				this.close();
		});
		window.addEventListener("keydown", e => {
			if (e.key === "Escape" && this.isOpen()) {
				e.stopImmediatePropagation();
				this.close();
			}
		}, true);
		this.render();
	},

	toggle(setting) {
		if (setting === "mute") {
			QuickChat.setMuted(!QuickChat.muted);
			return;
		}
		Settings[setting].toggle();
		this.enforceTextNeedsQuick();
		QuickChat.refresh();
		lobby.syncChatState();
	},

	enforceTextNeedsQuick() {
		if (!Settings.quickChat.isEnabled())
			Settings.textChat.disable();
	},

	isOpen() {
		return this.button.classList.contains("open");
	},

	open() {
		this.render();
		this.button.classList.add("open");
	},

	close() {
		this.button.classList.remove("open");
	},

	render() {
		if (!this.switches)
			return;
		for (const sw of this.switches) {
			const s = sw.dataset.setting;
			const on = s === "mute" ? QuickChat.muted : Settings[s].isEnabled();
			sw.setAttribute("aria-checked", on);
			if (s === "textChat")
				sw.disabled = !Settings.quickChat.isEnabled();
			if (s === "mute")
				sw.classList.toggle("hide", !mp.active);
		}
	}
};

QuickChat.init();
ChatLog.init();
ChatSettings.init();
