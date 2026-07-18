/*
 * fit-screen.js — scales the fixed 1920x1080 (16:9) canvas to fit viewports
 * that aren't ~16:9-16:10: pillarbox scale-down when wider, rotate+scale
 * when portrait. No-op (display:contents) otherwise.
 */
(function () {
	"use strict";

	var CANVAS_W = 1920;
	var CANVAS_H = 1080;
	var RATIO = CANVAS_H / CANVAS_W; // 0.5625

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

		if (vh >= vw) {
			// Portrait: rotate 90deg and scale to fill the tall screen.
			var sP = Math.min(vw / canvasH, vh / vw);
			var tx = vw / 2 + (sP * canvasH) / 2;
			var ty = vh / 2 - (sP * vw) / 2;
			transform = "translate(" + tx + "px, " + ty + "px) rotate(90deg) scale(" + sP + ")";
		} else if (canvasH > vh + 1) {
			// Landscape wider than 16:9: scale down to fit height, pillarbox sides.
			var sL = vh / canvasH;
			var txL = (vw - vw * sL) / 2;
			transform = "translate(" + txL + "px, 0px) scale(" + sL + ")";
		}
		// else: canvas already fits (<=16:9 landscape, incl. 16:10) -> no-op.

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
