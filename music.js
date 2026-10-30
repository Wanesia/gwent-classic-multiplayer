"use strict"

// Background music: the Gwent mix streamed from YouTube, controlled from a
// popover on the note in the settings cluster (play/pause, volume, tracks).
// Nothing is loaded from YouTube until music is turned on, so it never sees
// the IP or sets storage for players who leave music off (see privacy notice).
var Music = {
	VIDEO: "UE9fPWy1_o4",
	// The video plays the five tavern tracks twice; start times in seconds,
	// for both loops, from its description. The soundtrack has English titles
	// only, so they stay untranslated.
	TRACKS: [
		{ title: "The Nightingale", at: [0, 626] },
		{ title: "Back on the Path", at: [98, 725] },
		{ title: "Another Round for Everyone", at: [256, 882] },
		{ title: "A Story You Won't Believe", at: [372, 998] },
		{ title: "Unreleased Gwent", at: [468, 1095] }
	],
	END: 1255,
	volume: new SavedString("gc-music-volume", "50"),
	player: null,
	requested: false,
	pendingSeek: null,

	init() {
		this.button = document.getElementById("toggle-music");
		this.panel = document.getElementById("music-panel");
		const q = sel => this.panel.querySelector(sel);
		this.playBtn = q(".music-play");
		this.muteBtn = q(".music-mute");
		this.slider = q(".music-volume");
		this.volumeLabel = q(".music-volume-value");
		this.nowTitle = q(".music-now-title");
		this.nowTime = q(".music-now-time");
		this.progress = q(".music-progress");
		this.progressFill = q(".music-progress-fill");
		q(".music-prev").setAttribute("aria-label", I18N.t("music.prev"));
		q(".music-next").setAttribute("aria-label", I18N.t("music.next"));
		this.slider.setAttribute("aria-label", I18N.t("music.volume"));

		// Every stretch of the video, in order, so a time maps to its track
		this.segments = this.TRACKS.flatMap((t, i) => t.at.map(start => ({ i, start })))
			.sort((a, b) => a.start - b.start)
			.map((s, k, all) => ({ ...s, end: all[k + 1]?.start ?? this.END }));

		const list = q(".music-tracks");
		this.trackItems = this.TRACKS.map((t, i) => {
			const li = document.createElement("li");
			const btn = document.createElement("button");
			btn.type = "button";
			btn.tabIndex = -1;
			const name = document.createElement("span");
			name.textContent = this.TRACKS[i].title;
			const len = document.createElement("small");
			len.textContent = this.formatTime(this.segments.find(s => s.i === i).end - t.at[0]);
			btn.append(name, len);
			btn.addEventListener("click", () => this.playTrack(i));
			li.append(btn);
			list.append(li);
			return li;
		});

		// Keep focus on the game (its keyboard shortcuts) except while dragging the slider
		this.panel.addEventListener("mousedown", e => { if (e.target !== this.slider) e.preventDefault(); });
		this.button.addEventListener("click", e => {
			if (!this.panel.contains(e.target))
				this.isOpen() ? this.close() : this.open();
		});
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
		this.playBtn.addEventListener("click", () => this.setEnabled(!Settings.music.isEnabled()));
		this.muteBtn.addEventListener("click", () => this.toggleMute());
		this.slider.addEventListener("input", () => this.setVolume(this.slider.valueAsNumber));
		this.slider.addEventListener("pointerup", () => this.slider.blur());
		q(".music-prev").addEventListener("click", () => this.step(-1));
		q(".music-next").addEventListener("click", () => this.step(1));
		this.progress.addEventListener("pointerdown", e => this.seekTo(e));

		this.slider.value = this.getVolume();
		this.render();
		if (Settings.music.isEnabled())
			this.load();
	},

	formatTime(sec) {
		sec = Math.max(0, Math.floor(sec));
		return Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0");
	},

	getVolume() {
		const v = parseInt(this.volume.get(), 10);
		return Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 50;
	},

	// Loads the YouTube iframe API, which calls onYouTubeIframeAPIReady when done
	load() {
		if (this.requested)
			return;
		this.requested = true;
		const script = document.createElement("script");
		script.src = "https://www.youtube.com/iframe_api";
		document.head.appendChild(script);
	},

	initPlayer() {
		if (this.player)
			return;
		this.player = new YT.Player("youtube", {
			host: "https://www.youtube-nocookie.com",
			videoId: this.VIDEO,
			playerVars: { "autoplay": Settings.music.isEnabled() ? 1 : 0, "controls": 0, "loop": 1, "playlist": this.VIDEO, "rel": 0, "version": 3, "modestbranding": 1 },
			events: { "onReady": () => this.apply(), "onStateChange": () => this.render() }
		});
	},

	// YouTube blocked (adblock, offline) or not ready yet: onReady applies the settings later
	ready() {
		return typeof YT !== "undefined" && typeof this.player?.playVideo === "function";
	},

	setEnabled(enabled) {
		Settings.music.setEnabled(enabled);
		this.apply();
	},

	// The saved setting is the single source of truth: the icon shows it and the
	// player is told to follow it. (Deciding from the player's state instead
	// misread clicks while the video was buffering or failed to start, so the
	// button could get stuck "on" with no music.)
	apply() {
		const enabled = Settings.music.isEnabled();
		clearInterval(this.retry);
		this.render();
		if (enabled)
			this.load();
		if (!this.ready())
			return;
		this.player.unMute();
		this.player.setVolume(this.getVolume());
		if (!enabled) {
			this.player.pauseVideo();
			return;
		}
		if (this.pendingSeek !== null) {
			this.player.seekTo(this.pendingSeek, true);
			this.pendingSeek = null;
		}
		this.player.playVideo();
		// Browsers may refuse to start audio before the first user interaction:
		// keep asking until it plays, or until music is turned off again
		this.retry = setInterval(() => {
			if (!Settings.music.isEnabled() || this.player.getPlayerState() === YT.PlayerState.PLAYING)
				clearInterval(this.retry);
			else if (this.player.getPlayerState() !== YT.PlayerState.BUFFERING)
				this.player.playVideo();
		}, 500);
	},

	setVolume(v) {
		v = Math.min(100, Math.max(0, Math.round(v / 5) * 5));
		if (v > 0)
			this.unmuteTo = v;
		this.volume.set(String(v));
		this.slider.value = v;
		if (this.ready())
			this.player.setVolume(v);
		this.render();
	},

	// Mute remembers the last level to come back to
	toggleMute() {
		const v = this.getVolume();
		if (v > 0)
			this.unmuteTo = v;
		this.setVolume(v > 0 ? 0 : (this.unmuteTo || 50));
	},

	// Where the video is: its track, and the stretch of the video playing it
	position() {
		if (!this.ready())
			return null;
		const t = this.player.getCurrentTime() || 0;
		const seg = this.segments.findLast(s => s.start <= t) ?? this.segments[0];
		return { ...seg, t };
	},

	// Picking a track turns music on: it is an explicit request to hear it
	playTrack(i) {
		this.pendingSeek = this.TRACKS[i].at[0];
		this.shownTrack = i;
		this.setEnabled(true);
	},

	// Back restarts the current track first, like most players
	step(dir) {
		const pos = this.position();
		const i = pos ? pos.i : (this.shownTrack ?? 0);
		if (dir < 0 && pos && pos.t - pos.start > 3)
			return this.playTrack(i);
		this.playTrack((i + dir + this.TRACKS.length) % this.TRACKS.length);
	},

	seekTo(e) {
		const pos = this.position();
		if (!pos)
			return;
		const rect = this.progress.getBoundingClientRect();
		const f = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
		this.pendingSeek = pos.start + f * (pos.end - pos.start);
		this.setEnabled(true);
	},

	isOpen() {
		return this.button.classList.contains("open");
	},

	open() {
		this.button.classList.add("open");
		this.render();
		clearInterval(this.ticker);
		this.ticker = setInterval(() => this.render(), 500);
	},

	close() {
		this.button.classList.remove("open");
		clearInterval(this.ticker);
		if (document.activeElement === this.slider)
			this.slider.blur();
	},

	render() {
		const enabled = Settings.music.isEnabled();
		const v = this.getVolume();
		this.button.classList.toggle("fade", !enabled || v === 0);
		this.playBtn.classList.toggle("playing", enabled);
		this.playBtn.setAttribute("aria-label", I18N.t(enabled ? "music.pause" : "music.play"));
		this.muteBtn.classList.toggle("muted", v === 0);
		this.muteBtn.classList.toggle("quiet", v > 0 && v < 50);
		this.muteBtn.setAttribute("aria-label", I18N.t(v === 0 ? "music.unmute" : "music.mute"));
		this.volumeLabel.textContent = v + "%";
		this.slider.style.setProperty("--vol", v + "%");
		if (!this.isOpen())
			return;

		const pos = this.position();
		if (pos)
			this.shownTrack = pos.i;
		const i = this.shownTrack ?? 0;
		const start = pos ? pos.start : this.TRACKS[i].at[0];
		const end = pos ? pos.end : this.segments.find(s => s.start === start).end;
		const elapsed = pos ? pos.t - pos.start : 0;
		this.nowTitle.textContent = this.TRACKS[i].title;
		this.nowTime.textContent = this.formatTime(elapsed) + " / " + this.formatTime(end - start);
		this.progressFill.style.width = (100 * elapsed / (end - start)) + "%";
		this.progress.classList.toggle("disabled", !pos);
		this.trackItems.forEach((li, k) => li.classList.toggle("current", k === i));
	}
};

// Called by the YouTube iframe API once it has loaded
function onYouTubeIframeAPIReady() {
	Music.initPlayer();
}

Music.init();
