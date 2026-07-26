const { withAppBuildGradle } = require("@expo/config-plugins");

// Injects a real `release` signing config into the generated
// android/app/build.gradle. Expo prebuild regenerates that file (and `--clean`
// wipes any manual edit), so the release keystore has to be re-applied as a
// config plugin on every prebuild. Credentials are NOT hardcoded — they are read
// at build time from gradle properties:
//   COMPANION_UPLOAD_STORE_FILE, COMPANION_UPLOAD_STORE_PASSWORD,
//   COMPANION_UPLOAD_KEY_ALIAS,  COMPANION_UPLOAD_KEY_PASSWORD
// fastlane's .env sets these (see fastlane/.env.default); locally you can also put
// them in ~/.gradle/gradle.properties. When the store file property is absent the
// build falls back to the debug keystore, so `expo run:android` still works
// without any keystore configured.
module.exports = function withAndroidSigning(config) {
  return withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== "groovy") {
      throw new Error("withAndroidSigning: expected a groovy build.gradle");
    }
    let src = cfg.modResults.contents;

    if (src.includes("COMPANION_UPLOAD_STORE_FILE")) {
      return cfg; // already patched (idempotent across repeated prebuilds)
    }

    // 1. Add a `release` entry next to the existing `debug` signingConfig.
    src = src.replace(
      /(signingConfigs\s*\{\s*)(debug\s*\{)/,
      `$1release {
            if (project.hasProperty('COMPANION_UPLOAD_STORE_FILE')) {
                storeFile file(COMPANION_UPLOAD_STORE_FILE)
                storePassword COMPANION_UPLOAD_STORE_PASSWORD
                keyAlias COMPANION_UPLOAD_KEY_ALIAS
                keyPassword COMPANION_UPLOAD_KEY_PASSWORD
            }
        }
        $2`
    );

    // 2. Point the release buildType at the release signingConfig when the
    //    keystore property is present (else keep debug for local dev).
    src = src.replace(
      /(buildTypes\s*\{[\s\S]*?release\s*\{[\s\S]*?)signingConfig\s+signingConfigs\.debug/,
      "$1signingConfig project.hasProperty('COMPANION_UPLOAD_STORE_FILE') ? signingConfigs.release : signingConfigs.debug"
    );

    if (!src.includes("signingConfigs.release")) {
      throw new Error(
        "withAndroidSigning: could not patch build.gradle (upstream template changed). Update plugins/withAndroidSigning.js."
      );
    }

    cfg.modResults.contents = src;
    return cfg;
  });
};
