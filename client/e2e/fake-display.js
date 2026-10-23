// getDisplayMedia for headless Chromium: a moving canvas and a stereo tone.
(() => {
  const md = navigator.mediaDevices;
  md.getDisplayMedia = async (constraints = {}) => {
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
    const g = canvas.getContext('2d');
    let n = 0;
    const draw = () => {
      n++;
      g.fillStyle = `hsl(${(n * 3) % 360} 70% 40%)`;
      g.fillRect(0, 0, 1280, 720);
      g.fillStyle = '#fff';
      g.font = 'bold 120px sans-serif';
      g.fillText('frame ' + n, 100 + ((n * 7) % 600), 380);
    };
    const timer = setInterval(draw, 1000 / 30);
    draw();
    const stream = canvas.captureStream(30);
    const [vt] = stream.getVideoTracks();
    vt.addEventListener('ended', () => clearInterval(timer));
    const origStop = vt.stop.bind(vt);
    vt.stop = () => (clearInterval(timer), origStop());
    if (constraints.audio) {
      const ctx = new AudioContext();
      const dest = ctx.createMediaStreamDestination();
      dest.channelCount = 2;
      const merger = ctx.createChannelMerger(2);
      [440, 660].forEach((f, i) => {
        const o = ctx.createOscillator();
        const gain = ctx.createGain();
        o.frequency.value = f;
        gain.gain.value = 0.2;
        o.connect(gain).connect(merger, 0, i);
        o.start();
      });
      merger.connect(dest);
      stream.addTrack(dest.stream.getAudioTracks()[0]);
    }
    window.__fakeDisplayCalls = (window.__fakeDisplayCalls || 0) + 1;
    return stream;
  };
})();
