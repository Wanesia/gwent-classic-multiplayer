/*
 * fit-screen.js — scales the fixed 1920x1080 (16:9) canvas to fit viewports
 * that aren't ~16:9-16:10: pillarbox scale-down when wider, center when
 * portrait. No-op (display:contents) otherwise.
 */
(function () {
	"use strict";

	var CANVAS_W = 1920;
	var CANVAS_H = 1080;
	var RATIO = CANVAS_H / CANVAS_W; // 0.5625

	// Require a real ultrawide window (2560px+, 15%+ overshoot) before
	// pillarboxing on mouse/trackpad; touch keeps the tight check.
	var isTouch = ("ontouchstart" in window) || navigator.maxTouchPoints > 0;
	// The Pass button ends ~86% of the way down the canvas. A desktop window
	// too short to reach it (e.g. 1920x900) is scaled to fit even when it
	// isn't ultrawide, since there's no visible scrollbar. Windows only
	// shortened by ordinary browser chrome (1920x937+) keep full size.
	var HAND_BOTTOM = 0.86;

	function fit() {
		var wrap = document.getElementById("screen-scale");
		if (!wrap)
			return;

		var vw = window.innerWidth;
		var vh = window.innerHeight;
		if (!vw || !vh)
			return;

		var canvasH = vw * RATIO; // rendered height of the canvas at full width

		var transform = null;
		var scale = 1;

		if (vh >= vw) {
			// Portrait: no rotation, just center vertically (canvas is
			// always shorter than the viewport here).
			var extraV = vh - canvasH;
			transform = extraV > 1 ? "translateY(" + (extraV / 2) + "px)" : null;
		} else if (isTouch ? (canvasH > vh + 1) : ((vw >= 2560 && canvasH > vh * 1.15) || canvasH * HAND_BOTTOM > vh)) {
			// Landscape wider than 16:9: scale down to fit height, pillarbox sides.
			var sL = vh / canvasH;
			scale = sL;
			var txL = (vw - vw * sL) / 2;
			transform = "translate(" + txL + "px, 0px) scale(" + sL + ")";
		} else if (canvasH < vh * 0.9) {
			// Landscape taller than 16:10 (4:3, 3:2): center vertically like
			// portrait, instead of leaving a band below the board that the
			// fixed bottom controls drift into.
			transform = "translateY(" + ((vh - canvasH) / 2) + "px)";
		}
		// else: canvas already fits (16:9 to 16:10 landscape) -> no-op.
		// Exposed so px-sized text can compensate for the scale-down
		document.documentElement.style.setProperty("--fit-scale", scale);

		if (transform) {
			wrap.style.transform = transform;
			wrap.classList.add("fit-active");
			document.body.classList.add("fit-active");
			// Clamp overflow from the transformed canvas too.
			document.documentElement.style.overflow = "hidden";
		} else {
			wrap.style.transform = "";
			wrap.classList.remove("fit-active");
			document.body.classList.remove("fit-active");
			document.documentElement.style.overflow = "";
		}
	}

	// Debounce resize with rAF so rapid resize/rotation events stay smooth.
	var scheduled = false;
	function onResize() {
		if (scheduled)
			return;
		scheduled = true;
		window.requestAnimationFrame(function () {
			scheduled = false;
			fit();
		});
	}

	window.addEventListener("resize", onResize);
	window.addEventListener("orientationchange", onResize);

	if (document.readyState === "loading")
		document.addEventListener("DOMContentLoaded", fit);
	else
		fit();
})();
