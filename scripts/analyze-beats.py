#!/usr/bin/env python3
"""Estimate beat timestamps from a separated drum stem; emit one JSON object."""
import json
import sys

import librosa
import numpy as np


def main():
    source = sys.argv[1]
    hint = float(sys.argv[2]) if len(sys.argv) > 2 else 120.0
    audio, sample_rate = librosa.load(source, sr=22050, mono=True)
    if len(audio) < sample_rate * 10:
        raise ValueError("audio is too short for beat analysis")
    hop = 512
    onset = librosa.onset.onset_strength(y=audio, sr=sample_rate, hop_length=hop)
    tempo, beat_times = librosa.beat.beat_track(
        onset_envelope=onset,
        sr=sample_rate,
        hop_length=hop,
        start_bpm=hint,
        trim=False,
        units="time",
    )
    beats = np.asarray(beat_times, dtype=float)
    intervals = np.diff(beats)
    duration = len(audio) / sample_rate
    if len(beats) < 16 or len(intervals) == 0:
        print(json.dumps({"status": "needs_review", "reason": "not enough beats"}))
        return
    period = float(np.median(intervals))
    bpm = 60 / period if period > 0 else 0
    irregularity = float(np.median(np.abs(intervals - period)) / period) if period > 0 else 1
    coverage = float((beats[-1] - beats[0]) / duration)
    # These are deliberately conservative: a poor draft is worse than asking
    # the musician to set the first beat manually.
    reliable = (
        40 <= bpm <= 240
        and irregularity < 0.12
        and coverage > 0.75
        and beats[0] < 12
        and duration - beats[-1] < 12
    )
    print(json.dumps({
        "status": "ready" if reliable else "needs_review",
        "tempo": round(bpm, 2),
        "beats": [round(float(beat), 4) for beat in beats],
        "irregularity": round(irregularity, 4),
        "coverage": round(coverage, 4),
        "reason": "" if reliable else "beat grid needs review",
    }))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"status": "needs_review", "reason": str(error)[:200]}))
