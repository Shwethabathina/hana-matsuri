"""Render Hana Matsuri's ORIGINAL production soundtrack to MP3 (public/music/*.mp3).

All four pieces are composed for this project (yo / in-sen pentatonic scales) and synthesised here
from scratch: Karplus-Strong koto, a shakuhachi-style flute (meri bend, delayed vibrato, breath),
a soft pad, taiko, woodblock and suzu bells, through a generated convolution reverb. No samples or
third-party recordings are used, so the files can be distributed with the public game.

Each piece is rendered as a seamless loop: the reverb / ringing tail past the loop end is folded back
onto the start, so <audio loop> continues without a jump.

    python tools/music/render_soundtrack.py            # writes public/music/{festival,town,horror,finale}.mp3
"""
import os
import sys

import lameenc
import numpy as np
from scipy.signal import fftconvolve, lfilter

SR = 44100
OUT = os.path.join(os.path.dirname(__file__), '..', '..', 'public', 'music')


def scale_freq(base, semis):
    def f(n):
        octave, d = divmod(n, len(semis))
        return base * 2 ** ((semis[d] + 12 * octave) / 12)
    return f


# ------------------------------------------------------------------ instruments
_koto_cache = {}


def koto_note(freq, dur=2.6, bright=0.45, seed=0):
    """Karplus-Strong plucked string (block-vectorised)."""
    key = (round(freq, 2), dur, bright, seed)
    if key in _koto_cache:
        return _koto_cache[key]
    n_total = int(SR * dur)
    # the two-point average gives a loop delay of N - 0.5 samples -> f = SR / (N - 0.5)
    N = max(2, int(round(SR / freq + 0.5)))
    rng = np.random.default_rng(seed + int(freq * 10))
    burst = rng.uniform(-1, 1, N)
    burst = lfilter([1 - bright], [1, -bright], burst)  # softer silk-string attack
    damp = 0.4985 - min(0.004, freq / 400000)
    y = np.zeros(n_total + N + 1)
    y[:N] = burst
    i = N
    while i < n_total:
        prev = y[i - N:i + 1]  # N+1 samples of the previous period
        k = min(N, n_total - i)
        # y[i+j] = damp * (y[i+j-N] + y[i+j-N+1]); last element depends on y[i] computed in this block
        block = damp * (prev[:k] + prev[1:k + 1])
        y[i:i + k] = block
        if k == N:
            y[i + N - 1] = damp * (y[i - 1] + y[i])
        i += k
    out = y[:n_total]
    out *= np.exp(-np.arange(n_total) / (SR * dur * 0.55))
    _koto_cache[key] = out
    return out


def flute_note(freq, dur, seed=0):
    n = int(SR * (dur + 0.35))
    t = np.arange(n) / SR
    # meri: start ~2.5 % flat, bend up within 0.14 s
    bend = 1 - 0.025 * np.clip(1 - t / 0.14, 0, 1)
    vib_depth = 0.012 * np.clip((t - 0.25) / max(0.2, dur * 0.5), 0, 1)
    f = freq * bend * (1 + vib_depth * np.sin(2 * np.pi * 5.2 * t))
    ph = 2 * np.pi * np.cumsum(f) / SR
    tone = np.sin(ph) + 0.12 * np.sin(2 * ph) + 0.04 * np.sin(3 * ph)
    env = np.minimum(1, t / 0.12) * np.where(t < dur, 1 - 0.25 * np.clip((t - 0.2) / 0.8, 0, 1), np.exp(-(t - dur) / 0.08) * 0.75)
    rng = np.random.default_rng(seed)
    breath = rng.normal(0, 1, n)
    bw = 2 * np.pi * freq * 2 / SR
    breath = lfilter([bw], [1, -(1 - bw)], breath) - lfilter([bw * 0.5], [1, -(1 - bw * 0.5)], breath)
    breath *= np.exp(-t / 0.12) * 0.6
    return (tone + breath) * env


def pad_note(freq, dur):
    n = int(SR * (dur + 1.2))
    t = np.arange(n) / SR
    sig = np.zeros(n)
    for fr, amp in ((freq, 0.5), (freq * 1.004, 0.5), (freq * 1.5, 0.3)):
        sig += amp * (2 / np.pi) * np.arcsin(np.sin(2 * np.pi * fr * t))
    sig = lfilter([0.08], [1, -0.92], sig)
    env = np.minimum(1, t / 0.9) * np.where(t < dur - 0.4, 1, np.exp(-(t - dur + 0.4) / 0.35))
    return sig * env


def taiko_hit(gain=1.0, low=48, high=120, length=0.6, seed=0):
    n = int(SR * length)
    t = np.arange(n) / SR
    f = low + (high - low) * np.exp(-t / 0.06)
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.18)
    rng = np.random.default_rng(seed)
    skin = lfilter([0.15], [1, -0.85], rng.normal(0, 1, n)) * np.exp(-t / 0.03)
    return gain * (body + 0.5 * skin)


def woodblock(gain=1.0):
    n = int(SR * 0.09)
    t = np.arange(n) / SR
    f = 800 + 350 * np.exp(-t / 0.02)
    return gain * (2 / np.pi) * np.arcsin(np.sin(2 * np.pi * np.cumsum(f) / SR)) * np.exp(-t / 0.02)


def suzu(gain=1.0, seed=0):
    rng = np.random.default_rng(seed)
    n = int(SR * 0.9)
    out = np.zeros(n)
    for i in range(6):
        st = int(SR * (i * 0.05 + rng.uniform(0, 0.03)))
        m = n - st
        t = np.arange(m) / SR
        out[st:] += np.sin(2 * np.pi * rng.uniform(2600, 3800) * t) * np.exp(-t / 0.12)
    return gain * out


def drone(dur, freqs, swell=0.07, cutoff=380):
    n = int(SR * dur)
    t = np.arange(n) / SR
    sig = np.zeros(n)
    for i, fr in enumerate(freqs):
        saw = 2 * ((fr * t) % 1) - 1 if i < len(freqs) - 1 else (2 / np.pi) * np.arcsin(np.sin(2 * np.pi * fr * t))
        sig += saw * (0.5 if i < len(freqs) - 1 else 0.25)
    a = np.exp(-2 * np.pi * cutoff / SR)
    sig = lfilter([1 - a], [1, -a], lfilter([1 - a], [1, -a], sig))
    # whole cycles of the swell over the loop so the loop point is smooth
    cycles = max(1, round(swell * dur))
    return sig * (0.75 + 0.25 * np.sin(2 * np.pi * cycles * t / dur))


def wind(dur, seed=0):
    n = int(SR * dur)
    t = np.arange(n) / SR
    rng = np.random.default_rng(seed)
    x = rng.normal(0, 1, n)
    cycles = max(1, round(0.09 * dur))
    mod = 0.55 + 0.45 * np.sin(2 * np.pi * cycles * t / dur)
    a = np.exp(-2 * np.pi * 420 / SR)
    return lfilter([1 - a], [1, -a], x) * mod


# ------------------------------------------------------------------ mixing helpers
class Track:
    def __init__(self, seconds, tail=4.0):
        self.loop_len = int(SR * seconds)
        self.L = np.zeros(self.loop_len + int(SR * tail))
        self.R = np.zeros_like(self.L)

    def add(self, sig, at_sec, gain=1.0, pan=0.0):
        st = int(at_sec * SR)
        if st >= len(self.L):
            return
        sig = sig[: len(self.L) - st] * gain
        gl = np.cos((pan + 1) * np.pi / 4)
        gr = np.sin((pan + 1) * np.pi / 4)
        self.L[st:st + len(sig)] += sig * gl * 1.414
        self.R[st:st + len(sig)] += sig * gr * 1.414

    def add_bed(self, sig, gain=1.0, pan=0.0, xf=2.0):
        """A continuous bed (drone, wind) rendered `xf` seconds longer than the loop: its overhang is
        cross-faded into the start, so the loop point joins seamlessly."""
        n = self.loop_len
        k = int(SR * xf)
        assert len(sig) >= n + k
        out = sig[:n].copy()
        ramp = np.linspace(0, 1, k)
        out[:k] = sig[:k] * ramp + sig[n:n + k] * (1 - ramp)
        self.add(out, 0, gain, pan)

    def finish(self, wet=0.38, target_rms_db=-19.0, seed=1):
        rng = np.random.default_rng(seed)
        n_ir = int(SR * 2.8)
        decay = (1 - np.arange(n_ir) / n_ir) ** 3.2
        irl = rng.uniform(-1, 1, n_ir) * decay
        irr = rng.uniform(-1, 1, n_ir) * decay
        irl /= np.sqrt(np.sum(irl ** 2))
        irr /= np.sqrt(np.sum(irr ** 2))
        L = self.L * 0.8 + wet * fftconvolve(self.L, irl)[: len(self.L)]
        R = self.R * 0.8 + wet * fftconvolve(self.R, irr)[: len(self.R)]
        # fold the tail onto the start -> seamless loop
        n = self.loop_len
        tail_l, tail_r = L[n:], R[n:]
        L, R = L[:n].copy(), R[:n].copy()
        L[: len(tail_l)] += tail_l
        R[: len(tail_r)] += tail_r
        stereo = np.stack([L, R], axis=1)
        rms = np.sqrt(np.mean(stereo ** 2)) + 1e-9
        stereo *= 10 ** (target_rms_db / 20) / rms
        stereo = np.tanh(stereo * 1.1) / np.tanh(1.1) * 0.89  # gentle limiter, peaks < -1 dBFS
        return stereo


def write_mp3(stereo, name, kbps=128):
    os.makedirs(OUT, exist_ok=True)
    pcm = (np.clip(stereo, -1, 1) * 32767).astype('<i2')
    enc = lameenc.Encoder()
    enc.set_bit_rate(kbps)
    enc.set_in_sample_rate(SR)
    enc.set_channels(2)
    enc.set_quality(2)
    data = enc.encode(pcm.tobytes()) + enc.flush()
    path = os.path.join(OUT, f'{name}.mp3')
    with open(path, 'wb') as fh:
        fh.write(data)
    print(f'{path}: {len(stereo) / SR:.1f} s, {len(data) / 1e6:.2f} MB')


# ------------------------------------------------------------------ pieces
YO = [0, 2, 5, 7, 9]  # yo scale (D E G A B on D)
INSEN = [0, 1, 5, 7, 10]  # in-sen (D Eb G A C on D): dark, haunting


def piece_festival():
    """The festival theme (same composition as the in-game procedural score): 76 BPM, ~101 s."""
    f = scale_freq(293.66, YO)
    E = 60 / 76 / 2
    A_BASS = [0, 0, 2, 0, 0, 3, 2, 0]
    B_BASS = [-1, -1, 2, 3, -1, 2, 3, 0]
    BASS = A_BASS + A_BASS + B_BASS + A_BASS
    MEL_A = [(5, 2), (6, 1), (7, 1), (6, 2), (5, 2), (4, 3), (2, 1), (3, 4), (5, 2), (7, 1), (8, 1), (7, 2), (6, 1), (5, 1), (4, 2), (3, 1), (2, 1), (0, 4)]
    MEL_B = [(7, 3), (8, 1), (9, 2), (8, 2), (7, 2), (6, 2), (5, 4), (6, 2), (7, 1), (6, 1), (5, 2), (4, 2), (3, 2), (4, 1), (5, 1), (5, 4)]
    MEL_A2 = [(None, 2), (5, 1), (6, 1), (7, 2), (5, 2), (4, 2), (3, 1), (2, 1), (3, 4), (5, 2), (7, 1), (8, 1), (7, 2), (6, 1), (5, 1), (4, 2), (2, 2), (0, 4)]
    PAT = [[0, None, 2, 4, 5, None, 4, 2], [0, 2, 4, None, 5, 4, 2, None], [5, None, 4, 2, 4, None, 2, 0]]
    T = Track(len(BASS) * 8 * E)
    for bar, root in enumerate(BASS):
        t0 = bar * 8 * E
        T.add(pad_note(f(root - 5), 8 * E), t0, 0.05)
        pat = PAT[(bar // 8) % 3]
        for e, off in enumerate(pat):
            if off is None or (8 <= bar < 24 and e % 2 == 1 and bar % 2 == 1):
                continue
            fr = f(root + off)
            T.add(koto_note(fr), t0 + e * E + (E * 0.12 if e % 2 else 0), (0.2 if e == 0 else 0.13) * (1.1 if bar < 8 else 0.9),
                  pan=float(np.clip((np.log2(fr / 293.66) - 0.3) * 0.5, -0.6, 0.6)))
        if bar >= 16:
            T.add(taiko_hit(seed=bar), t0, 0.22)
        if bar % 8 == 0:
            T.add(suzu(seed=bar), t0, 0.035)
    for mel, bar0 in ((MEL_A, 8), (MEL_B, 16), (MEL_A2, 24)):
        t = bar0 * 8 * E
        for n, beats in mel:
            if n is not None:
                T.add(flute_note(f(n), beats * 2 * E, seed=int(t * 10)), t, 0.075, pan=0.1)
            t += beats * 2 * E
    return T.finish()


def piece_town():
    """Old Town: an unhurried walking theme, 64 BPM in G, koto + flute + soft woodblock, ~90 s."""
    f = scale_freq(196.0, YO)  # G3
    E = 60 / 64 / 2
    BASS = [0, 0, 3, 2, 0, 0, 2, 3, 4, 3, 2, 0, -1, 0, 2, 0, 0, 3, 2, 0, 3, 2, 0, 0]
    MEL = [(5, 3), (7, 1), (6, 4), (5, 2), (3, 2), (4, 4), (2, 3), (3, 1), (5, 2), (4, 2), (3, 6), (None, 2),
           (7, 2), (8, 2), (7, 2), (5, 2), (6, 4), (5, 4), (3, 2), (5, 2), (4, 2), (3, 2), (2, 6), (None, 2),
           (5, 2), (6, 1), (7, 1), (8, 4), (7, 2), (5, 2), (6, 3), (5, 1), (3, 4), (2, 2), (3, 2), (0, 8)]
    T = Track(len(BASS) * 8 * E)
    for bar, root in enumerate(BASS):
        t0 = bar * 8 * E
        T.add(pad_note(f(root), 8 * E), t0, 0.04)
        # sparse, rolling koto: root-fifth-octave with a passing note
        for e, off in enumerate([0, None, 2, None, 5, None, 3, 2] if bar % 2 == 0 else [5, None, 3, None, 2, None, 0, None]):
            if off is None:
                continue
            fr = f(root + 5 + off)
            T.add(koto_note(fr, bright=0.55), t0 + e * E + (E * 0.15 if e % 2 else 0), 0.12, pan=float(np.clip((np.log2(fr / 392) ) * 0.5, -0.5, 0.5)))
        if bar >= 4:
            for e in (2, 6):
                T.add(woodblock(), t0 + e * E, 0.025, pan=-0.3)
        if bar % 8 == 0:
            T.add(taiko_hit(low=55, high=110, seed=bar), t0, 0.1)
    t = 0.0
    for rep in range(1):
        t = 0
        for n, beats in MEL:
            if n is not None:
                T.add(flute_note(f(n + 5), beats * 2 * E, seed=int(t * 10)), t, 0.06, pan=0.15)
            t += beats * 2 * E
    return T.finish(wet=0.42, target_rms_db=-21.0)


def piece_horror():
    """Test of Courage: drone, wind, in-sen koto plucks, breath phrases and a slow heartbeat, ~96 s."""
    dur = 96.0
    rng = np.random.default_rng(7)
    f = scale_freq(220.0, INSEN)  # A3 in-sen
    T = Track(dur, tail=4.0)
    T.add_bed(drone(dur + 2, [55, 55 * 1.007, 82.4 * 0.995, 116.5]), 0.11)
    T.add_bed(wind(dur + 2, seed=3), 0.06, pan=-0.2)
    t = 2.0
    while t < dur - 2:
        n = int(rng.integers(0, 10))
        fr = f(n) * (0.5 if rng.random() < 0.3 else 1)
        T.add(koto_note(fr, dur=3.0, bright=0.3, seed=int(t)), t, 0.16, pan=float(rng.uniform(-0.6, 0.6)))
        if rng.random() < 0.35:
            T.add(koto_note(fr * 1.414, dur=2.6, bright=0.3, seed=int(t) + 1), t + 0.03, 0.09, pan=float(rng.uniform(-0.6, 0.6)))
        t += 2.2 + rng.random() * 3.5
    t = 6.0
    while t < dur - 4:
        T.add(flute_note(f(int(rng.integers(5, 9))) * 0.995, 1.8 + rng.random(), seed=int(t)) * 0.6, t, 0.05, pan=float(rng.uniform(-0.4, 0.4)))
        t += 7 + rng.random() * 6
    # heartbeat in the second half
    t = dur * 0.5
    while t < dur - 1.5:
        T.add(taiko_hit(low=40, high=80, length=0.5, seed=int(t * 10)), t, 0.12)
        T.add(taiko_hit(low=38, high=70, length=0.5, seed=int(t * 10) + 1), t + 0.28, 0.08)
        t += 1.25
    return T.finish(wet=0.5, target_rms_db=-22.0)


def piece_finale():
    """Lantern Festival finale: bright and full, 96 BPM in D, taiko ensemble, ~100 s."""
    f = scale_freq(293.66, YO)
    E = 60 / 96 / 2
    INTRO = [0, 0, 2, 0]
    A = [0, 0, 2, 0, 0, 3, 2, 0]
    B = [-1, -1, 2, 3, -1, 2, 3, 0]
    BASS = INTRO + A + B + A + B + A + [0, 0, 0, 0]
    MEL_A = [(5, 2), (6, 1), (7, 1), (6, 2), (5, 2), (4, 3), (2, 1), (3, 4), (5, 2), (7, 1), (8, 1), (7, 2), (6, 1), (5, 1), (4, 2), (3, 1), (2, 1), (0, 4)]
    MEL_B = [(7, 3), (8, 1), (9, 2), (8, 2), (7, 2), (6, 2), (5, 4), (6, 2), (7, 1), (6, 1), (5, 2), (4, 2), (3, 2), (4, 1), (5, 1), (5, 4)]
    MEL_END = [(10, 4), (9, 2), (8, 2), (7, 4), (5, 4), (5, 16)]
    T = Track(len(BASS) * 8 * E, tail=5.0)
    for bar, root in enumerate(BASS):
        t0 = bar * 8 * E
        T.add(pad_note(f(root - 5), 8 * E), t0, 0.06)
        T.add(pad_note(f(root), 8 * E), t0, 0.03)
        for e, off in enumerate([0, 2, 4, 5, 7, 5, 4, 2]):
            fr = f(root + off)
            T.add(koto_note(fr, bright=0.5), t0 + e * E, 0.11 if e else 0.17, pan=float(np.clip((np.log2(fr / 293.66) - 0.3) * 0.6, -0.6, 0.6)))
        if bar >= 4 and bar < len(BASS) - 4:
            T.add(taiko_hit(seed=bar), t0, 0.3)
            T.add(taiko_hit(seed=bar + 100), t0 + 4 * E, 0.2)
            T.add(taiko_hit(low=70, high=160, length=0.35, seed=bar + 200), t0 + 6 * E, 0.12, pan=0.3)
            T.add(taiko_hit(low=70, high=160, length=0.35, seed=bar + 300), t0 + 7 * E, 0.1, pan=-0.3)
            for e in (3, 7):
                T.add(woodblock(), t0 + e * E, 0.04, pan=0.4)
        if bar % 4 == 0:
            T.add(suzu(seed=bar), t0, 0.05)
    t = 4 * 8 * E
    for mel in (MEL_A, MEL_B, MEL_A, MEL_B, MEL_A, MEL_END):
        for n, beats in mel:
            if n is not None:
                d = beats * 2 * E
                T.add(flute_note(f(n), d, seed=int(t * 10)), t, 0.075, pan=0.1)
                T.add(flute_note(f(n - 5), d, seed=int(t * 10) + 1), t + 0.01, 0.03, pan=-0.15)
            t += beats * 2 * E
    # closing roll
    end = (len(BASS) - 4) * 8 * E
    for i in range(16):
        T.add(taiko_hit(seed=900 + i), end + i * E * 0.5, 0.12 + i * 0.012)
    T.add(taiko_hit(gain=1.4, seed=999), end + 8 * E, 0.4)
    T.add(suzu(seed=998), end + 8 * E, 0.08)
    return T.finish(wet=0.36, target_rms_db=-18.0)


if __name__ == '__main__':
    which = sys.argv[1:] or ['festival', 'town', 'horror', 'finale']
    for name in which:
        write_mp3({'festival': piece_festival, 'town': piece_town, 'horror': piece_horror, 'finale': piece_finale}[name](), name)
