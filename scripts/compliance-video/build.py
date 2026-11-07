"""Build the narrated training videos for the Compliance Hub.

For each compliance-content/<key>.json this renders the slides (render-slides.js),
reads each slide's narration with the Kokoro text-to-speech voice, and stitches
them into compliance-videos/<key>.mp4 -- each slide stays up exactly as long as
its narration. It also writes the real running time back into the JSON as
estimated_minutes, so the "About N minutes" on the lesson page is true.

Re-run it whenever a course's narration changes:

    python build.py                 # every course
    python build.py hipaa ethics_conduct

Needs: ffmpeg, node with playwright, and a Python with `kokoro-onnx` and
`soundfile` installed plus the two Kokoro model files. Point at them with
KOKORO_MODEL and KOKORO_VOICES (defaults: ./models/kokoro-v1.0.onnx and
./models/voices-v1.0.bin next to this script). The model files are from
https://github.com/thewh1teagle/kokoro-onnx/releases (model-files-v1.0).
"""
import json, os, subprocess, sys, tempfile
import soundfile as sf
import numpy as np
from kokoro_onnx import Kokoro

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
CONTENT = os.path.join(ROOT, "compliance-content")
VIDEOS = os.path.join(ROOT, "compliance-videos")
VOICE = os.environ.get("KOKORO_VOICE", "af_heart")
SPEED = float(os.environ.get("KOKORO_SPEED", "1.0"))
LEAD, TAIL = 0.6, 0.9  # seconds of quiet before and after each slide's narration


def build(key, tts, work):
    src = os.path.join(CONTENT, key + ".json")
    c = json.load(open(src))
    frames = os.path.join(work, key)
    subprocess.run(["node", os.path.join(HERE, "render-slides.js"), src, frames], check=True)
    segs = []
    total = 0.0
    for i, s in enumerate(c["slides"]):
        audio, sr = tts.create(s["narration"], voice=VOICE, speed=SPEED, lang="en-us")
        audio = np.concatenate([np.zeros(int(LEAD * sr)), audio, np.zeros(int(TAIL * sr))]).astype("float32")
        wav = os.path.join(frames, "a-%02d.wav" % i)
        sf.write(wav, audio, sr)
        dur = len(audio) / sr
        total += dur
        seg = os.path.join(frames, "seg-%02d.mp4" % i)
        subprocess.run([
            "ffmpeg", "-y", "-loglevel", "error", "-loop", "1", "-framerate", "2",
            "-i", os.path.join(frames, "slide-%02d.png" % i), "-i", wav,
            "-t", "%.3f" % dur, "-c:v", "libx264", "-tune", "stillimage", "-preset", "medium",
            "-crf", "32", "-pix_fmt", "yuv420p", "-r", "2", "-g", "10",
            "-c:a", "aac", "-b:a", "48k", "-ac", "1", "-ar", "24000", seg], check=True)
        segs.append(seg)
        print("  %s slide %d/%d  %.1fs" % (key, i + 1, len(c["slides"]), dur), flush=True)
    lst = os.path.join(frames, "list.txt")
    with open(lst, "w") as f:
        f.writelines("file '%s'\n" % p for p in segs)
    os.makedirs(VIDEOS, exist_ok=True)
    out = os.path.join(VIDEOS, key + ".mp4")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", lst,
                    "-c", "copy", "-movflags", "+faststart", out], check=True)
    c["estimated_minutes"] = max(1, round(total / 60))
    with open(src, "w") as f:
        json.dump(c, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print("%s: %.1f min, %.1f MB" % (key, total / 60, os.path.getsize(out) / 1e6), flush=True)


def main():
    keys = sys.argv[1:] or sorted(f[:-5] for f in os.listdir(CONTENT) if f.endswith(".json"))
    tts = Kokoro(os.environ.get("KOKORO_MODEL", os.path.join(HERE, "models", "kokoro-v1.0.onnx")),
                 os.environ.get("KOKORO_VOICES", os.path.join(HERE, "models", "voices-v1.0.bin")))
    with tempfile.TemporaryDirectory() as work:
        for k in keys:
            build(k, tts, work)


if __name__ == "__main__":
    main()
