// Records the app's AudioContexts so the harness can read their underrun counts.
export const PROBE_SCRIPT = `(() => {
  const Orig = globalThis.AudioContext;
  if (!Orig || globalThis.__perfAudioRead) return;
  const contexts = [];
  globalThis.AudioContext = class extends Orig {
    constructor(...args) {
      super(...args);
      contexts.push(new WeakRef(this));
    }
  };
  globalThis.__perfAudioRead = () => ({
    features: { playbackStats: 'playbackStats' in Orig.prototype },
    contexts: contexts.flatMap((ref, id) => {
      const c = ref.deref();
      if (!c) return [];
      let playback;
      try {
        playback = c.playbackStats && { underrunEvents: c.playbackStats.underrunEvents };
      } catch {}
      return [{ id, playback }];
    }),
  });
})();`;
