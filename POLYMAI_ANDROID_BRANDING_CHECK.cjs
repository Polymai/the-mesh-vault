const fs = require("fs");
const path = require("path");

const root = __dirname;
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const activity = read("mobile/android-wrapper/android/app/src/main/java/io/github/polymai/the_mesh_vault/MainActivity.java");
const service = read("mobile/android-wrapper/android/app/src/main/java/io/github/polymai/the_mesh_vault/PolymaiBackgroundService.java");
const manifest = read("mobile/android-wrapper/android/app/src/main/AndroidManifest.xml");
const styles = read("mobile/android-wrapper/android/app/src/main/res/values/styles.xml");
const strings = read("mobile/android-wrapper/android/app/src/main/res/values/strings.xml");
const gradle = read("mobile/android-wrapper/android/app/build.gradle");
const packageJson = read("mobile/android-wrapper/package.json");

assert(activity.includes("showNativeLoader()"), "Native hosted-app loader is missing.");
assert(activity.includes("document.readyState==='complete'"), "Loader does not wait for the hosted app.");
assert(activity.includes("LOADER_TIMEOUT_MS"), "Loader has no bounded timeout.");
assert(activity.includes("ActivityCompat.requestPermissions"), "Android notification permission is not requested at runtime.");
assert(activity.includes("showNotificationReady()"), "Notification permission has no visible confirmation.");
assert(manifest.includes("android.permission.POST_NOTIFICATIONS"), "POST_NOTIFICATIONS is missing from the manifest.");
assert(manifest.includes("android.permission.FOREGROUND_SERVICE"), "Foreground-service permission is missing from the manifest.");
assert(service.includes("R.drawable.ic_stat_meshvault"), "Background notification does not use the branded status icon.");
assert(service.includes("setOngoing(true)"), "Background-node notification is not persistent.");
assert(styles.includes("windowSplashScreenBackground") && styles.includes("ic_launcher_foreground"), "Branded Android splash theme is incomplete.");
assert(strings.includes("Allow node notifications?"), "Notification onboarding copy is missing.");
assert(/versionCode\s+2\b/.test(gradle) && /versionName\s+"3\.0\.1"/.test(gradle), "Android upgrade version was not incremented.");
assert(packageJson.includes("generate-android-branding.ps1"), "Android sync does not regenerate branded assets.");

for (const relative of [
  "mobile/android-wrapper/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png",
  "mobile/android-wrapper/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_foreground.png",
  "mobile/android-wrapper/android/app/src/main/res/drawable-port-xxxhdpi/splash.png",
  "mobile/android-wrapper/android/app/src/main/res/drawable/ic_stat_meshvault.xml",
]) {
  assert(fs.existsSync(path.join(root, relative)), `Missing Android branding asset: ${relative}`);
}

console.log("POLYMAI_ANDROID_BRANDING_CHECK passed");
