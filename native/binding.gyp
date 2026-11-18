{
  "variables": {
    # node-gyp rebuild -- -Dsanitize=address,undefined   (or thread)
    "sanitize%": ""
  },
  "targets": [
    {
      "target_name": "qobuz_audio",
      "sources": ["src/qobuz_audio.cc"],
      "include_dirs": ["<!(node -p \"require('node-addon-api').include_dir\")"],
      "defines": ["NAPI_VERSION=8", "NAPI_DISABLE_CPP_EXCEPTIONS", "NODE_ADDON_API_DISABLE_DEPRECATED"],
      "cflags_cc!": ["-fno-exceptions", "-fno-rtti"],
      "cflags_cc": ["-std=c++17", "-O2", "-fvisibility=hidden", "-Wall", "-Wno-unused-function", "-Wno-unused-variable"],
      "cflags": ["-O2"],
      "libraries": ["-ldl", "-lpthread", "-lm"],
      "conditions": [
        ["sanitize!=''", {
          "cflags_cc": ["-fsanitize=<(sanitize)", "-fno-omit-frame-pointer", "-g", "-O1"],
          "cflags": ["-fsanitize=<(sanitize)", "-fno-omit-frame-pointer", "-g", "-O1"],
          "ldflags": ["-fsanitize=<(sanitize)"]
        }]
      ]
    }
  ]
}
