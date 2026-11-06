#!/usr/bin/env bash
# Runs after `cap add android`. Every step is safe to skip if something is already there.
set -u
cd "$(dirname "$0")/.."
MANIFEST=android/app/src/main/AndroidManifest.xml

# 1. Microphone permission and speech-service visibility (Android 11 and up)
python3 - "$MANIFEST" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding='utf-8').read()
add = ''
if 'android.permission.RECORD_AUDIO' not in s:
    add += '    <uses-permission android:name="android.permission.RECORD_AUDIO" />\n'
if 'android.permission.MODIFY_AUDIO_SETTINGS' not in s:
    add += '    <uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />\n'
if 'android.speech.RecognitionService' not in s:
    add += '    <queries>\n        <intent>\n            <action android:name="android.speech.RecognitionService" />\n        </intent>\n    </queries>\n'
if add:
    s = s.replace('</manifest>', add + '</manifest>')
    open(p, 'w', encoding='utf-8').write(s)
print('manifest ok')
PY

# 2. Launcher icon from resources/icon.png
if ! command -v convert >/dev/null 2>&1; then
  sudo apt-get update -y >/dev/null 2>&1 && sudo apt-get install -y imagemagick >/dev/null 2>&1
fi
if command -v convert >/dev/null 2>&1 && [ -f resources/icon.png ]; then
  RES=android/app/src/main/res
  rm -rf "$RES"/mipmap-anydpi-v26
  for pair in mdpi:48 hdpi:72 xhdpi:96 xxhdpi:144 xxxhdpi:192; do
    d="${pair%%:*}"; px="${pair##*:}"
    mkdir -p "$RES/mipmap-$d"
    convert resources/icon.png -resize "${px}x${px}" "$RES/mipmap-$d/ic_launcher.png"
    cp "$RES/mipmap-$d/ic_launcher.png" "$RES/mipmap-$d/ic_launcher_round.png"
    rm -f "$RES/mipmap-$d/ic_launcher_foreground.png"
  done
  echo "icons ok"
else
  echo "icons skipped (ImageMagick missing)"
fi

# 3. Keep the screen on while the app is open so recording is not cut off in class
JAVA=$(find android/app/src/main/java -name MainActivity.java | head -1)
if [ -n "$JAVA" ] && grep -q 'public class MainActivity extends BridgeActivity {}' "$JAVA"; then
  python3 - "$JAVA" <<'PY'
import sys, re
p = sys.argv[1]
s = open(p, encoding='utf-8').read()
s = re.sub(r'(package [^;]+;)', r'\1\n\nimport android.os.Bundle;\nimport android.view.WindowManager;', s, count=1)
s = s.replace('public class MainActivity extends BridgeActivity {}',
 'public class MainActivity extends BridgeActivity {\n    @Override\n    public void onCreate(Bundle savedInstanceState) {\n        super.onCreate(savedInstanceState);\n        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);\n    }\n}')
open(p, 'w', encoding='utf-8').write(s)
print('keep-screen-on ok')
PY
else
  echo "keep-screen-on skipped"
fi
