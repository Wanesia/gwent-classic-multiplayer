"use strict"

// A restart the server announced (`make maintenance`, see server/server.js):
// a countdown at the top of every screen, so nobody starts an online match
// that would be cut off. Heard from the relay when connected, from the
// presence poll on the lobby screens, and elsewhere (deck builder, a match vs
// the computer) by asking /presence itself. The countdown is in the player's
// language; a message written for this restart, if any, goes under it as is.
var Maintenance = {
	POLL_MS: 30000,
	// After the restart is due: until the relay says there is none any more,
	// or this long, whichever comes first
	STALE_MS: 10 * 60 * 1000,
	elem: document.getElementById("maintenance"),
	countdown: document.querySelector("#maintenance .maintenance-countdown"),
	messageElem: document.querySelector("#maintenance .maintenance-message"),
	at: null, // when the restart is due, by this browser's clock; null when none
	message: "",
	timer: null,

	init() {
		setInterval(() => this.poll(), this.POLL_MS);
		document.addEventListener("visibilitychange", () => this.poll());
	},

	// Not in a hidden tab, nor on the lobby screens: Presence asks there
	async poll() {
		if (document.hidden || Presence.view)
			return;
		const counts = await Net.presence();
		if (counts)
			this.set(counts.maintenanceIn, counts.maintenanceMessage);
	},

	// ms: time left as the relay counts it; anything else: no restart planned.
	// message: shown under the countdown, as text
	set(ms, message) {
		this.at = typeof ms === "number" ? Date.now() + ms : null;
		this.message = this.at !== null && typeof message === "string" ? message : "";
		clearInterval(this.timer);
		this.timer = this.at === null ? null : setInterval(() => this.render(), 1000);
		this.render();
	},

	render() {
		const left = this.at === null ? null : this.at - Date.now();
		if (left !== null && left < -this.STALE_MS)
			return this.set(null);
		this.elem.classList.toggle("hide", left === null);
		if (left === null)
			return;
		this.countdown.textContent = left > 0
			? I18N.t("maintenance.soon", { min: Math.ceil(left / 60000) })
			: I18N.t("maintenance.now");
		this.messageElem.textContent = this.message;
		this.messageElem.classList.toggle("hide", !this.message);
	},
};

Maintenance.init();
