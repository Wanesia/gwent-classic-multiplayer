// Shared by the replay tests: plays real matches through the UI code paths.
// A player that acts through the same UI functions a click would reach. Like
// clicks, its actions are never awaited: a pick can open the next picker.
function installBot(page, seed) {
	return page.evaluate(seed => {
		let s = seed >>> 0;
		const rand = n => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s % n; };
		const acting = { busy: false };
		window.botStop = false;
		const tick = async () => {
			if (window.botStop || acting.busy || game.state.val !== 10)
				return;
			acting.busy = true;
			try {
				if (Popup.curr) {
					(window.botPopups = window.botPopups || []).push(document.querySelector('#popup h3').textContent);
					rand(2) ? Popup.curr.selectYes() : Popup.curr.selectNo();
				} else if (Carousel.curr && !Carousel.curr.selecting) {
					const c = Carousel.curr;
					// redraws and optional pickers can also be closed early
					if (c.bExit && rand(4) === 0) c.cancel();
					else {
						c.index = rand(c.indices.length);
						c.update();
						c.select(new Event('click'));
					}
				} else if (game.placedEffectsActive && ui.previewCard) {
					// forced row choice (agile medic revive, Skellige round 3)
					const rows = board.row.filter(r => r.elem.classList.contains('row-selectable'));
					if (rows.length) ui.selectRow(rows[rand(rows.length)]);
				} else if (game.currPlayer === player_me && player_me.awaitingAction && !document.getElementsByTagName('main')[0].classList.contains('noclick')) {
					const hand = player_me.hand.cards;
					if (player_me.leaderAvailable && rand(8) === 0) {
						player_me.elem_leader.click();
					} else if (!hand.length || (hand.length < 4 && rand(3) === 0) || rand(9) === 0) {
						document.getElementById('pass-button').click();
					} else {
						const card = hand[rand(hand.length)];
						const dests = card.name === 'Scorch' ? [] : mp.legalDests(card, player_me);
						if (card.name === 'Decoy') {
							const rows = dests.filter(r => r.cards.some(c => c.isUnit()));
							if (!rows.length) { document.getElementById('pass-button').click(); return; }
							const row = rows[rand(rows.length)];
							const units = row.cards.filter(c => c.isUnit());
							ui.selectCard(card);
							ui.lastRow = row;
							ui.selectCard(units[rand(units.length)]);
						} else if (card.name === 'Scorch') {
							ui.selectCard(card);
							ui.selectRow(board.row[rand(6)]);
						} else if (dests.length) {
							ui.selectCard(card);
							ui.selectRow(dests[rand(dests.length)]);
						} else {
							document.getElementById('pass-button').click();
						}
					}
				}
			} catch (e) {
				console.error('bot', e);
			} finally {
				acting.busy = false;
			}
		};
		clearInterval(window.botTimer);
		window.botTimer = setInterval(tick, 40);
		window.botState = () => JSON.stringify({ st: game.state.val, round: game.roundCount, cur: game.currPlayer === player_me ? "me" : game.currPlayer ? "op" : null, aw: player_me.awaitingAction, car: !!Carousel.curr, sel: Carousel.curr && Carousel.curr.selecting, pop: !!Popup.curr, pe: game.placedEffectsActive, pv: !!ui.previewCard, busy: acting.busy, hand: player_me.hand.cards.length });
	}, seed);
}

module.exports = { installBot };
