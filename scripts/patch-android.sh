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

# 3. MainActivity: keep the screen on while recording, and hand Google sign-in
#    results to the social login plugin
JAVA=$(find android/app/src/main/java -name MainActivity.java | head -1)
if [ -n "$JAVA" ]; then
  PKG=$(grep -m1 '^package ' "$JAVA" | sed 's/package //; s/;//; s/[[:space:]]//g')
  cat > "$JAVA" <<EOF
package $PKG;

import android.content.Intent;
import android.os.Bundle;
import android.util.Log;
import android.view.WindowManager;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginHandle;
import ee.forgr.capacitor.social.login.GoogleProvider;
import ee.forgr.capacitor.social.login.ModifiedMainActivityForSocialLoginPlugin;
import ee.forgr.capacitor.social.login.SocialLoginPlugin;

public class MainActivity extends BridgeActivity implements ModifiedMainActivityForSocialLoginPlugin {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    @Override
    public void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode >= GoogleProvider.REQUEST_AUTHORIZE_GOOGLE_MIN && requestCode < GoogleProvider.REQUEST_AUTHORIZE_GOOGLE_MAX) {
            PluginHandle pluginHandle = getBridge().getPlugin("SocialLogin");
            if (pluginHandle == null) {
                Log.i("Google Activity Result", "SocialLogin login handle is null");
                return;
            }
            Plugin plugin = pluginHandle.getInstance();
            if (!(plugin instanceof SocialLoginPlugin)) {
                Log.i("Google Activity Result", "SocialLogin plugin instance is not SocialLoginPlugin");
                return;
            }
            ((SocialLoginPlugin) plugin).handleGoogleLoginIntent(requestCode, data);
        }
    }

    // Required by the social login plugin. Never called.
    @Override
    public void IHaveModifiedTheMainActivityForTheUseWithSocialLoginPlugin() {}
}
EOF
  echo "main activity ok"
else
  echo "main activity skipped"
fi
