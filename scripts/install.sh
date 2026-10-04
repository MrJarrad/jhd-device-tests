#!/usr/bin/env bash
# Third-party installs. Runs in its own workflow step: no repo secrets are in its environment.
set -euo pipefail
APPIUM_VERSION=3.8.0
XCUITEST_VERSION=12.15.0
brew install age ffmpeg >/dev/null 2>&1   # bottles are sha256-checked by Homebrew; ffmpeg only ever sees the recording
npm i -g "appium@$APPIUM_VERSION" >/dev/null 2>&1
appium driver install "xcuitest@$XCUITEST_VERSION" >/dev/null 2>&1
appium --version
