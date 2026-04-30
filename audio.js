// =============================================================================
// audio.js — sound system hooks. Real audio files are optional.
// If a file exists at the expected path it will play; otherwise the call is a
// no-op. This keeps gameplay quiet but ready for sound integration.
//
// Drop these files (any/all) into ./assets/sfx/ to enable sound:
//   card_play.mp3, hit.mp3, castle_damage.mp3, victory.mp3, defeat.mp3,
//   spell_fire.mp3, spell_heal.mp3, click.mp3, deny.mp3
// =============================================================================

const Sound = (() => {
  const cache = {};
  let muted = false;
  let unlocked = false; // iOS Safari blocks audio until a user gesture

  function load(name, file) {
    const a = new Audio(`assets/sfx/${file}`);
    a.preload = "auto";
    a.volume = 0.6;
    a.addEventListener("error", () => { cache[name] = null; }, { once: true });
    cache[name] = a;
  }

  function play(name) {
    if (muted) return;
    const a = cache[name];
    if (!a) return;
    try {
      const clone = a.cloneNode();
      clone.volume = a.volume;
      clone.play().catch(() => {});
    } catch (_) { /* ignore */ }
  }

  // iOS / Safari refuse to play <audio> until the user has interacted with
  // the page. We wire a one-shot listener on pointerdown/touchstart that
  // briefly plays + pauses every cached sound to "unlock" them.
  function unlockAudioOnce() {
    if (unlocked) return;
    unlocked = true;
    Object.values(cache).forEach((a) => {
      if (!a) return;
      try {
        a.muted = true;
        const p = a.play();
        if (p && p.then) {
          p.then(() => {
            a.pause();
            a.currentTime = 0;
            a.muted = false;
          }).catch(() => { a.muted = false; });
        } else {
          a.pause();
          a.muted = false;
        }
      } catch (_) { /* ignore */ }
    });
    document.removeEventListener("pointerdown", unlockAudioOnce);
    document.removeEventListener("touchstart",  unlockAudioOnce);
    document.removeEventListener("keydown",     unlockAudioOnce);
  }
  document.addEventListener("pointerdown", unlockAudioOnce, { once: false });
  document.addEventListener("touchstart",  unlockAudioOnce, { once: false });
  document.addEventListener("keydown",     unlockAudioOnce, { once: false });

  // preload (silently ignored if files are missing)
  load("card",        "card_play.mp3");
  load("hit",         "hit.mp3");
  load("castle",      "castle_damage.mp3");
  load("victory",     "victory.mp3");
  load("defeat",      "defeat.mp3");
  load("spellFire",   "spell_fire.mp3");
  load("spellHeal",   "spell_heal.mp3");
  load("click",       "click.mp3");
  load("deny",        "deny.mp3");

  return {
    playCardSound:         () => play("card"),
    playHitSound:          () => play("hit"),
    playCastleDamageSound: () => play("castle"),
    playVictorySound:      () => play("victory"),
    playDefeatSound:       () => play("defeat"),
    playSpellFireSound:    () => play("spellFire"),
    playSpellHealSound:    () => play("spellHeal"),
    playClickSound:        () => play("click"),
    playDenySound:         () => play("deny"),
    setMuted: (v) => { muted = !!v; },
    isMuted: () => muted,
  };
})();
