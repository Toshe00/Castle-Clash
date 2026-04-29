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
