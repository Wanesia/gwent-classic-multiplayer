"use strict"

// Who is around, on the lobby screens: how many people have the game open, and
// whether someone is waiting in Quick Match (pressing it then pairs at once).
// Asked from the relay when the lobby screen changes and every 30 seconds.
var Presence = {
	POLL_MS: 30000,
	// Not while searching (it would be yourself) or waiting for a friend
	OFFER_VIEWS: ["lobby-mode", "lobby-mp"],
	elem: document.getElementById("menu-presence"),
	count: document.querySelector("#menu-presence .presence-count"),
	waitingButton: document.querySelector("#menu-presence .presence-waiting"),
	quickOption: document.getElementById("lobby-quick-button"),
	quickDesc: document.querySelector("#lobby-quick-button .quick-desc"),
	quickWaiting: document.querySelector("#lobby-quick-button .quick-waiting"),
	counts: null, // {online, waiting}, null when unknown
	view: null, // id of the lobby screen shown

	init() {
		this.waitingButton.addEventListener("click", () => lobby.findOpponent());
		setInterval(() => { if (this.view) this.refresh(); }, this.POLL_MS);
		// Our own class changes land here too, so only a change of screen acts
		new MutationObserver(() => this.screenChanged())
			.observe(lobby.elem, { attributes: true, attributeFilter: ["class"], subtree: true });
		document.addEventListener("visibilitychange", () => this.screenChanged());
		// After the visit is counted, so the count includes this player
		Stats.visited.then(() => this.screenChanged());
	},

	currentView() {
		if (document.hidden || lobby.elem.classList.contains("hide"))
			return null;
		const shown = [...lobby.elem.getElementsByClassName("lobby-view")].find(v => !v.classList.contains("hide"));
		return shown ? shown.id : null;
	},

	screenChanged() {
		const view = this.currentView();
		if (view === this.view)
			return;
		// Coming back from a match or another tab: don't show what was true then
		if (!this.view)
			this.counts = null;
		this.view = view;
		this.render();
		if (view)
			this.refresh();
	},

	async refresh() {
		this.counts = await Net.presence();
		if (this.counts)
			Maintenance.set(this.counts.maintenanceIn);
		this.render();
	},

	render() {
		const c = this.counts;
		const offer = !!(c && c.waiting && this.OFFER_VIEWS.includes(this.view));
		// Alone, "Online: 1" would only say the game is empty
		this.elem.classList.toggle("hide", !this.view || !c || (c.online < 2 && !offer));
		if (c)
			this.count.textContent = I18N.t("lobby.presenceOnline", { n: c.online });
		this.waitingButton.classList.toggle("hide", !offer);
		this.quickOption.classList.toggle("someone-waiting", offer);
		this.quickDesc.classList.toggle("hide", offer);
		this.quickWaiting.classList.toggle("hide", !offer);
	},
};

Presence.init();
