`speech-16k.wav`: English speech synthesised with the open-source Flite TTS (ffmpeg's
`flite` filter, voice `slt`). Used by `audio.spec.ts`, which mixes in noise.

Objective voice tests (`voice-quality.spec.ts`), all CC BY 4.0, from the Microsoft DNS Challenge
(https://github.com/microsoft/DNS-Challenge, branch interspeech2020/master; Reddy et al., "The
INTERSPEECH 2020 Deep Noise Suppression Challenge"), unchanged:
- `dns-clean-0.wav`, `dns-clean-101.wav`: `datasets/test_set/synthetic/no_reverb/clean/clean_fileid_0.wav`
  and `clean_fileid_101.wav` (clean read speech, 16 kHz).
- `noise-keyboard.wav`: `datasets/noise/GuASa1smc8c.wav` (AudioSet clip GuASa1smc8c, labelled typing).
- `noise-fan.wav`: `datasets/noise/YZ1pFAGWEYc.wav` (AudioSet clip YZ1pFAGWEYc, labelled mechanical fan / hum).
