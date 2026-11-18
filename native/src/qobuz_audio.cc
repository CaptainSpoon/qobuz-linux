// qobuz_audio.cc — Linux drop-in replacement for Qobuz's Windows-only juce.node.
//
// The Qobuz main process loads `juce.node` via process.dlopen and calls the
// export as a factory: `const player = require("juce.node")()`. The returned
// object must implement the API the bundled TrackController / playerEvents
// code uses (open/openStream/play/pause/status/offset/...), plus
// newCacheRanges() objects used to track which byte/time ranges of a
// progressively-downloaded track buffer are filled.
//
// Audio: miniaudio (PulseAudio / PipeWire-pulse / ALSA / JACK loaded at
// runtime). Decoding: miniaudio's built-in dr_flac / dr_mp3. Decryption is
// already done in JS before bytes reach us; the buffer is a plain FLAC/MP3
// byte stream (HLS segments are concatenated without the MP4 wrapper).
//
// Test mode (QOBUZ_AUDIO_TEST=1): no sound device is opened. Output is
// produced on demand by player.__render(frames), and the background
// maintenance work runs only when player.__maintain() is called, so tests are
// deterministic and can compare rendered samples exactly.

#define MINIAUDIO_IMPLEMENTATION
#define MA_NO_ENCODING
#define MA_NO_GENERATION
#define MA_NO_ENGINE
#define MA_NO_NODE_GRAPH
#define MA_NO_RESOURCE_MANAGER
#define MA_NO_WAV
#include "miniaudio.h"

#include <napi.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace {

// ---------------------------------------------------------------- logging
bool g_debug = getenv("QOBUZ_AUDIO_DEBUG") != nullptr;
#define QLOG(...)                                         \
  do {                                                    \
    if (g_debug) {                                        \
      fprintf(stderr, "[qobuz-audio] " __VA_ARGS__);      \
      fputc('\n', stderr);                                \
    }                                                     \
  } while (0)

// Bytes that must be buffered ahead of the decoder cursor before decoding.
// Larger than any FLAC/MP3 frame plus dr_flac's read cache; if the decoder
// still runs into a gap, the slot is re-synced by seeking once data arrives.
// Adjustable in test mode to force the re-sync path.
std::atomic<size_t> g_readMargin{64 * 1024};

uint64_t secToFrame(double sec, uint32_t rate) {
  if (sec <= 0 || !rate) return 0;
  return uint64_t(std::llround(sec * rate));
}

// ---------------------------------------------------------------- ranges
std::atomic<uint64_t> g_seq{0};
std::atomic<uint64_t> g_starvedReads{0};  // diagnostics

struct LogEntry {
  double start, end;
  uint64_t seq;
};

// A set of [start,end) ranges (bytes or seconds), merged, plus the raw
// insertion log (used to pair HLS time segments with their byte segments).
struct RangeSet {
  std::mutex m;
  std::vector<std::pair<double, double>> merged;
  std::vector<LogEntry> log;
  double cacheSize = 0;

  void add(double s, double e) {
    if (e <= s) return;
    std::lock_guard<std::mutex> l(m);
    log.push_back({s, e, ++g_seq});
    merged.emplace_back(s, e);
    std::sort(merged.begin(), merged.end());
    std::vector<std::pair<double, double>> out;
    for (auto& r : merged) {
      if (!out.empty() && r.first <= out.back().second)
        out.back().second = std::max(out.back().second, r.second);
      else
        out.push_back(r);
    }
    merged.swap(out);
  }
  bool contains(double x) {
    std::lock_guard<std::mutex> l(m);
    for (auto& r : merged)
      if (x >= r.first && x <= r.second) return true;
    return false;
  }
  // End of the merged range containing x (x itself if none).
  double contiguousEnd(double x) {
    std::lock_guard<std::mutex> l(m);
    for (auto& r : merged)
      if (x >= r.first && x < r.second) return r.second;
    return x;
  }
  bool isComplete() {
    std::lock_guard<std::mutex> l(m);
    return cacheSize > 0 && merged.size() == 1 && merged[0].first <= 0 &&
           merged[0].second >= cacheSize;
  }
  std::vector<LogEntry> logCopy() {
    std::lock_guard<std::mutex> l(m);
    return log;
  }
  std::vector<std::pair<double, double>> mergedCopy() {
    std::lock_guard<std::mutex> l(m);
    return merged;
  }
};

class CacheRangesWrap : public Napi::ObjectWrap<CacheRangesWrap> {
 public:
  static Napi::FunctionReference ctor;
  std::shared_ptr<RangeSet> rs = std::make_shared<RangeSet>();

  static Napi::Function Init(Napi::Env env) {
    Napi::Function f = DefineClass(
        env, "CacheRanges",
        {InstanceMethod("addRange", &CacheRangesWrap::AddRange),
         InstanceMethod("setCacheSize", &CacheRangesWrap::SetCacheSize),
         InstanceMethod("isComplete", &CacheRangesWrap::IsComplete),
         InstanceMethod("contains", &CacheRangesWrap::Contains),
         InstanceMethod("getRangeCopy", &CacheRangesWrap::GetRangeCopy)});
    ctor = Napi::Persistent(f);
    ctor.SuppressDestruct();
    return f;
  }
  explicit CacheRangesWrap(const Napi::CallbackInfo& info)
      : Napi::ObjectWrap<CacheRangesWrap>(info) {}

  Napi::Value AddRange(const Napi::CallbackInfo& info) {
    rs->add(info[0].ToNumber().DoubleValue(), info[1].ToNumber().DoubleValue());
    return info.Env().Undefined();
  }
  Napi::Value SetCacheSize(const Napi::CallbackInfo& info) {
    std::lock_guard<std::mutex> l(rs->m);
    rs->cacheSize = info[0].ToNumber().DoubleValue();
    return info.Env().Undefined();
  }
  Napi::Value IsComplete(const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(), rs->isComplete());
  }
  Napi::Value Contains(const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(),
                              rs->contains(info[0].ToNumber().DoubleValue()));
  }
  Napi::Value GetRangeCopy(const Napi::CallbackInfo& info) {
    double mult = info.Length() > 0 && info[0].IsNumber()
                      ? info[0].ToNumber().DoubleValue()
                      : 1.0;
    auto m = rs->mergedCopy();
    Napi::Array a = Napi::Array::New(info.Env(), m.size());
    for (size_t i = 0; i < m.size(); i++) {
      Napi::Object o = Napi::Object::New(info.Env());
      o.Set("start", m[i].first * mult);
      o.Set("end", m[i].second * mult);
      a.Set(i, o);
    }
    return a;
  }
};
Napi::FunctionReference CacheRangesWrap::ctor;

// ---------------------------------------------------------------- slot
struct FlacInfo {
  uint32_t sampleRate = 0, channels = 0, bps = 0;
  uint64_t totalSamples = 0;
};

bool parseFlacHeader(const uint8_t* p, size_t n, FlacInfo* fi) {
  if (n < 42 || memcmp(p, "fLaC", 4) != 0) return false;
  if ((p[4] & 0x7F) != 0) return false;  // first block must be STREAMINFO
  const uint8_t* s = p + 8;
  fi->sampleRate = (uint32_t(s[10]) << 12) | (uint32_t(s[11]) << 4) | (s[12] >> 4);
  fi->channels = ((s[12] >> 1) & 0x7) + 1;
  fi->bps = (((s[12] & 1) << 4) | (s[13] >> 4)) + 1;
  fi->totalSamples = (uint64_t(s[13] & 0x0F) << 32) | (uint64_t(s[14]) << 24) |
                     (uint64_t(s[15]) << 16) | (uint64_t(s[16]) << 8) | s[17];
  return true;
}

// One decodable track (current or next). All fields are guarded by Player::mtx.
struct Slot {
  bool opened = false;
  bool isStream = false;
  std::string ext;
  std::string path;
  Napi::Reference<Napi::Buffer<uint8_t>> bufRef;  // JS thread only
  const uint8_t* data = nullptr;
  size_t size = 0;
  std::shared_ptr<RangeSet> timeRanges, dataRanges;
  uint64_t samplesHint = 0;

  // virtual byte stream presented to the decoder: concatenation of pieces
  std::vector<std::pair<size_t, size_t>> vmap;  // (realStart, len)
  size_t vsize = 0, vcursor = 0;
  bool starved = false;

  ma_decoder dec;
  bool decInit = false;
  uint32_t sampleRate = 0, channels = 0, bps = 0;
  uint64_t totalFrames = 0;
  uint64_t posFrames = 0;
  uint64_t discardFrames = 0;
  bool eof = false;       // decoder exhausted
  bool finished = false;  // all frames handed to the device
  bool needResync = false;
  bool pendingSeek = false;
  double pendingSeekSec = 0;

  double durationSec() const {
    return sampleRate ? double(totalFrames) / sampleRate : 0.0;
  }
};

// Map a virtual offset to a real buffer offset; returns false if out of range.
bool vmapReal(const Slot* s, size_t v, size_t* real, size_t* pieceLeft) {
  size_t acc = 0;
  for (auto& p : s->vmap) {
    if (v < acc + p.second) {
      *real = p.first + (v - acc);
      *pieceLeft = p.second - (v - acc);
      return true;
    }
    acc += p.second;
  }
  return false;
}

ma_result vsRead(ma_decoder* d, void* out, size_t n, size_t* nread) {
  Slot* s = static_cast<Slot*>(d->pUserData);
  size_t total = 0;
  while (total < n && s->vcursor < s->vsize) {
    size_t real, left;
    if (!vmapReal(s, s->vcursor, &real, &left)) break;
    size_t can = std::min(n - total, left);
    if (s->isStream && s->dataRanges) {
      size_t availEnd = size_t(s->dataRanges->contiguousEnd(double(real)));
      if (availEnd <= real) {
        s->starved = true;
        g_starvedReads++;
        break;
      }
      can = std::min(can, availEnd - real);
    }
    memcpy(static_cast<uint8_t*>(out) + total, s->data + real, can);
    total += can;
    s->vcursor += can;
  }
  if (getenv("QA_TRACE")) fprintf(stderr, "read req=%zu got=%zu cursor=%zu avail=%zu\n", n, total, s->vcursor, s->dataRanges ? size_t(s->dataRanges->contiguousEnd(0)) : 0);
  *nread = total;
  if (total == 0 && n > 0) return MA_AT_END;
  return MA_SUCCESS;
}

ma_result vsSeek(ma_decoder* d, ma_int64 off, ma_seek_origin origin) {
  Slot* s = static_cast<Slot*>(d->pUserData);
  ma_int64 base = origin == ma_seek_origin_start     ? 0
                  : origin == ma_seek_origin_current ? ma_int64(s->vcursor)
                                                     : ma_int64(s->vsize);
  ma_int64 np = base + off;
  if (np < 0 || np > ma_int64(s->vsize)) return MA_BAD_SEEK;
  s->vcursor = size_t(np);
  return MA_SUCCESS;
}

// Whether the bytes ahead of the decoder cursor are buffered (see g_readMargin).
bool streamHasMargin(const Slot* s) {
  if (!s->isStream || !s->dataRanges) return true;
  size_t real, left;
  if (!vmapReal(s, s->vcursor, &real, &left)) return true;  // at end
  size_t remainingV = s->vsize - s->vcursor;
  size_t need = std::min<size_t>(g_readMargin.load(), remainingV);
  size_t got = 0, v = s->vcursor;
  while (got < need) {
    size_t r, l;
    if (!vmapReal(s, v, &r, &l)) break;
    size_t availEnd = size_t(s->dataRanges->contiguousEnd(double(r)));
    if (availEnd <= r) return false;
    size_t chunk = std::min(l, availEnd - r);
    got += chunk;
    v += chunk;
    if (chunk < l) break;  // gap inside this piece
  }
  return got >= need;
}

void slotUninitDecoder(Slot* s) {
  if (s->decInit) {
    ma_decoder_uninit(&s->dec);
    s->decInit = false;
  }
}

bool slotInitDecoder(Slot* s) {
  slotUninitDecoder(s);
  ma_decoder_config cfg = ma_decoder_config_init(ma_format_f32, 0, 0);
  cfg.encodingFormat =
      s->ext == "mp3" ? ma_encoding_format_mp3 : ma_encoding_format_flac;
  ma_result r;
  if (s->isStream) {
    s->vcursor = 0;
    s->starved = false;
    r = ma_decoder_init(vsRead, vsSeek, s, &cfg, &s->dec);
  } else {
    r = ma_decoder_init_file(s->path.c_str(), &cfg, &s->dec);
  }
  if (r != MA_SUCCESS) {
    QLOG("decoder init failed: %s", ma_result_description(r));
    return false;
  }
  s->decInit = true;
  ma_format f;
  ma_uint32 ch, sr;
  ma_decoder_get_data_format(&s->dec, &f, &ch, &sr, nullptr, 0);
  if (!s->sampleRate) s->sampleRate = sr;
  if (!s->channels) s->channels = ch;
  return true;
}

// Read stream parameters and initialise the decoder. Safe to call again for a
// stream whose header bytes had not arrived yet. Returns true once decodable.
bool slotProbe(Slot* s) {
  if (s->ext == "flac" && !s->totalFrames) {
    FlacInfo fi;
    bool ok = false;
    if (s->isStream) {
      size_t avail = s->dataRanges ? size_t(s->dataRanges->contiguousEnd(0)) : s->size;
      ok = parseFlacHeader(s->data, std::min(avail, s->size), &fi);
    } else if (FILE* f = fopen(s->path.c_str(), "rb")) {
      uint8_t hdr[64];
      size_t n = fread(hdr, 1, sizeof hdr, f);
      fclose(f);
      ok = parseFlacHeader(hdr, n, &fi);
    }
    if (ok) {
      s->sampleRate = fi.sampleRate;
      s->channels = fi.channels;
      s->bps = fi.bps;
      s->totalFrames = fi.totalSamples;
    }
  }
  if (!slotInitDecoder(s)) return false;
  if (!s->totalFrames) {
    if (s->samplesHint) {
      s->totalFrames = s->samplesHint;
    } else if (!s->isStream) {
      ma_uint64 len = 0;
      ma_decoder_get_length_in_pcm_frames(&s->dec, &len);
      s->totalFrames = len;
      ma_decoder_seek_to_pcm_frame(&s->dec, 0);
    } else if (s->ext == "mp3" && s->sampleRate) {
      // Qobuz MP3 is 320 kbps CBR; estimate (no length scan over a partial buffer)
      s->totalFrames = uint64_t(double(s->size) * 8.0 / 320000.0 * s->sampleRate);
    }
  }
  if (!s->bps) s->bps = 16;
  return true;
}

// ---------------------------------------------------------------- player
struct DeviceSel {
  std::string name;  // display name, "" = system default
  bool isDefault = true;
  ma_device_id id{};
};

class Player {
 public:
  const bool testMode;

  std::mutex mtx;                  // slots + playback state below
  std::unique_ptr<Slot> slots[2];  // 0 = current, 1 = next
  bool autoAdvanced = false;       // device already rendering slot[1]
  std::atomic<bool> playing{false};
  std::atomic<bool> blocked{false};
  std::atomic<float> gain{1.0f};
  std::atomic<double> lookAhead{0};
  std::atomic<uint64_t> statResyncs{0};  // diagnostics
  std::vector<float> scratch;  // render thread only

  std::recursive_mutex devMtx;  // device lifecycle + selection
  ma_context ctx;
  bool ctxInit = false;
  std::string backendName = "Audio";
  ma_device device;
  bool devInit = false;
  std::atomic<bool> devStarted{false};
  std::atomic<uint32_t> devRate{0}, devChannels{0};
  DeviceSel sel;

  std::mutex enumMtx;  // ma_context_get_devices returns shared buffers
  std::vector<std::string> fakeDevices;
  bool useFakeDevices = false;

  std::mutex tsfnMtx;
  Napi::ThreadSafeFunction deviceTsfn;
  bool haveTsfn = false;
  std::string lastDeviceSig;

  std::thread maint;
  std::atomic<bool> quit{false};

  Player() : testMode(getenv("QOBUZ_AUDIO_TEST") != nullptr) {
    slots[0].reset(new Slot());
    slots[1].reset(new Slot());
    ma_context_config cc = ma_context_config_init();
    cc.pulse.pApplicationName = "Qobuz";
    // QOBUZ_AUDIO_BACKEND=null: real device + maintenance threads, silent
    // output (used for threaded stress tests under sanitizers).
    const char* be = getenv("QOBUZ_AUDIO_BACKEND");
    bool useNull = testMode || (be && strcmp(be, "null") == 0);
    ma_backend nullBackend[] = {ma_backend_null};
    if (ma_context_init(useNull ? nullBackend : nullptr, useNull ? 1 : 0, &cc, &ctx) == MA_SUCCESS) {
      ctxInit = true;
      backendName = ma_get_backend_name(ctx.backend);
    }
    QLOG("audio backend: %s%s", backendName.c_str(), testMode ? " (test mode)" : "");
    if (!testMode) maint = std::thread([this] { maintenanceLoop(); });
  }

  ~Player() {
    quit = true;
    if (maint.joinable()) maint.join();
    stopDevice(true);
    if (ctxInit) ma_context_uninit(&ctx);
  }

  // ---------------- devices
  struct DevEntry {
    std::string name;
    ma_device_id id;
    bool isDefault;
  };
  std::vector<DevEntry> enumerate() {
    std::lock_guard<std::mutex> l(enumMtx);
    std::vector<DevEntry> out;
    out.push_back({"System default", {}, true});
    if (useFakeDevices) {
      for (auto& n : fakeDevices) out.push_back({n, {}, false});
      return out;
    }
    if (!ctxInit) return out;
    ma_device_info* pb;
    ma_uint32 n;
    ma_device_info* cap;
    ma_uint32 nc;
    if (ma_context_get_devices(&ctx, &pb, &n, &cap, &nc) == MA_SUCCESS) {
      for (ma_uint32 i = 0; i < n; i++) out.push_back({pb[i].name, pb[i].id, false});
    }
    return out;
  }

  static void dataCallback(ma_device* dev, void* out, const void*, ma_uint32 frames) {
    static_cast<Player*>(dev->pUserData)->render(static_cast<float*>(out), frames);
  }

  // Must NOT be called with mtx held (stopping waits for the audio callback).
  void stopDevice(bool uninit) {
    std::lock_guard<std::recursive_mutex> d(devMtx);
    if (devInit && devStarted) {
      if (!testMode) ma_device_stop(&device);
      devStarted = false;
    }
    if (uninit && devInit) {
      if (!testMode) ma_device_uninit(&device);
      devInit = false;
      devRate = 0;
      devChannels = 0;
    }
  }

  // Ensure an output device matching the track format. Returns "" or error.
  std::string ensureDevice(uint32_t rate, uint32_t ch) {
    std::lock_guard<std::recursive_mutex> d(devMtx);
    if (!ctxInit) return "No audio backend available";
    if (devInit && devRate == rate && devChannels == ch) return "";
    stopDevice(true);
    if (testMode) {
      devInit = true;
      devRate = rate;
      devChannels = ch;
      return "";
    }
    ma_device_config dc = ma_device_config_init(ma_device_type_playback);
    dc.playback.format = ma_format_f32;
    dc.playback.channels = ch;
    dc.sampleRate = rate;
    dc.playback.pDeviceID = sel.isDefault ? nullptr : &sel.id;
    dc.dataCallback = &Player::dataCallback;
    dc.pUserData = this;
    dc.periodSizeInMilliseconds = 20;
    dc.performanceProfile = ma_performance_profile_conservative;
    ma_result r = ma_device_init(&ctx, &dc, &device);
    if (r != MA_SUCCESS) return std::string("Couldn't open device: ") + ma_result_description(r);
    devInit = true;
    devRate = rate;
    devChannels = ch;
    QLOG("device opened %u Hz %u ch (hw %u Hz)", rate, ch, device.playback.internalSampleRate);
    return "";
  }

  // Open (if needed) and start the device for the given format.
  std::string startPlayback(uint32_t rate, uint32_t ch) {
    std::lock_guard<std::recursive_mutex> d(devMtx);
    std::string err = ensureDevice(rate, ch);
    if (!err.empty()) return err;
    if (!devStarted) {
      if (!testMode) {
        ma_result r = ma_device_start(&device);
        if (r != MA_SUCCESS) return std::string("Couldn't start device: ") + ma_result_description(r);
      }
      devStarted = true;
    }
    return "";
  }

  // ---------------- audio thread (or __render in test mode)
  void render(float* out, ma_uint32 frames) {
    const uint32_t ch = devChannels;
    std::unique_lock<std::mutex> l(mtx, std::defer_lock);
    if (testMode) l.lock(); else (void)l.try_lock();
    if (!l.owns_lock() || !playing) {
      memset(out, 0, sizeof(float) * frames * ch);
      return;
    }
    ma_uint32 done = 0;
    bool wasBlocked = false;
    while (done < frames) {
      Slot* s = autoAdvanced ? slots[1].get() : slots[0].get();
      if (!s->opened || s->channels != ch || !s->decInit || s->pendingSeek || s->needResync) {
        if (s->opened && !s->finished) wasBlocked = true;
        break;
      }
      if (s->eof) {
        if (!s->finished) {
          s->finished = true;
          QLOG("track finished");
        }
        // gapless continuation into the prepared next track
        Slot* n = slots[1].get();
        if (!autoAdvanced && n->opened && n->decInit && n->sampleRate == s->sampleRate &&
            n->channels == ch && !n->pendingSeek && !n->needResync) {
          autoAdvanced = true;
          QLOG("gapless advance to next track");
          continue;
        }
        break;
      }
      if (!streamHasMargin(s)) {
        wasBlocked = true;
        break;
      }
      if (s->discardFrames) {
        ma_uint64 drop = std::min<ma_uint64>(s->discardFrames, 4096);
        if (scratch.size() < drop * ch) scratch.resize(drop * ch);
        ma_uint64 got = 0;
        ma_decoder_read_pcm_frames(&s->dec, scratch.data(), drop, &got);
        s->discardFrames -= std::min<ma_uint64>(got, s->discardFrames);
        s->posFrames += got;
        if (got < drop) {
          s->discardFrames = 0;
          if (s->starved) { s->needResync = true; statResyncs++; }
          else s->eof = true;
        }
        continue;
      }
      ma_uint64 want = frames - done;
      if (s->totalFrames && s->posFrames < s->totalFrames)
        want = std::min<ma_uint64>(want, s->totalFrames - s->posFrames);
      ma_uint64 got = 0;
      float* dst = out + size_t(done) * ch;
      ma_decoder_read_pcm_frames(&s->dec, dst, want, &got);
      if (got) {
        float g = gain.load();
        if (g != 1.0f)
          for (ma_uint64 i = 0; i < got * ch; i++) dst[i] *= g;
      }
      s->posFrames += got;
      done += ma_uint32(got);
      if (got < want) {
        if (s->starved) {
          s->needResync = true;  // decoder hit a gap: re-seek when data arrives
          statResyncs++;
          wasBlocked = true;
          break;
        }
        s->eof = true;
      }
      if (s->totalFrames && s->posFrames >= s->totalFrames) s->eof = true;
    }
    if (done < frames) memset(out + size_t(done) * ch, 0, sizeof(float) * (frames - done) * ch);
    blocked = wasBlocked && done == 0;
  }

  // ---------------- seeking (mtx held)
  // Try to position slot at `sec`. Returns true if done, false if must wait.
  bool trySeek(Slot* s, double sec) {
    if (!s->opened || !s->sampleRate) return false;
    uint64_t target = secToFrame(sec, s->sampleRate);
    if (s->totalFrames && target >= s->totalFrames) target = s->totalFrames - 1;
    s->eof = s->finished = false;
    s->discardFrames = 0;
    const size_t margin = g_readMargin.load();

    bool linearOk = !s->isStream || s->dataRanges->isComplete();
    if (!linearOk && s->isStream) {
      // contiguous from 0 past the (estimated) byte position?
      double frac = s->totalFrames ? double(target) / s->totalFrames : 0;
      size_t est = size_t(frac * s->size) + std::max<size_t>(margin, 64 * 1024);
      size_t c0 = size_t(s->dataRanges->contiguousEnd(0));
      if (c0 >= std::min(est, s->size)) linearOk = true;
    }
    if (linearOk) {
      if (s->isStream && s->vmap.size() != 1) {
        s->vmap = {{0, s->size}};
        s->vsize = s->size;
        if (!slotInitDecoder(s)) return false;
      }
      if (!s->decInit && !slotInitDecoder(s)) return false;
      s->starved = false;
      if (ma_decoder_seek_to_pcm_frame(&s->dec, target) != MA_SUCCESS || s->starved) {
        s->starved = false;
        return false;
      }
      s->posFrames = target;
      return true;
    }

    // HLS: locate the segment containing `sec` via paired time/byte logs.
    // A time entry pairs with the latest byte entry added before it (the JS
    // adds the byte range, then the matching time range, for each segment).
    auto tlog = s->timeRanges ? s->timeRanges->logCopy() : std::vector<LogEntry>();
    auto dlog = s->dataRanges->logCopy();
    if (dlog.empty()) return false;
    auto pairOf = [&](const LogEntry& t) -> const LogEntry* {
      const LogEntry* best = nullptr;
      for (auto& d : dlog)
        if (d.seq < t.seq && (!best || d.seq > best->seq)) best = &d;
      return best;
    };
    // header = first byte entry if it starts at 0 and is not paired with time
    size_t headerLen = 0;
    {
      bool paired = false;
      for (auto& t : tlog)
        if (pairOf(t) == &dlog[0]) { paired = true; break; }
      if (dlog[0].start == 0 && !paired) headerLen = size_t(dlog[0].end);
    }
    if (!headerLen) return false;
    for (auto& t : tlog) {
      if (!(sec >= t.start && sec < t.end)) continue;
      const LogEntry* seg = pairOf(t);
      if (!seg) continue;
      size_t segStart = size_t(seg->start);
      size_t availEnd = size_t(s->dataRanges->contiguousEnd(double(segStart)));
      if (availEnd < std::min(segStart + margin, s->size)) return false;
      s->vmap = {{0, headerLen}, {segStart, s->size - segStart}};
      s->vsize = headerLen + (s->size - segStart);
      if (!slotInitDecoder(s)) return false;
      uint64_t segFrame = secToFrame(t.start, s->sampleRate);
      s->posFrames = segFrame;
      s->discardFrames = target > segFrame ? target - segFrame : 0;
      QLOG("segment seek to %.3fs via segment @%.3fs (byte %zu)", sec, t.start, segStart);
      return true;
    }
    return false;
  }

  // One round of background work: late header probes, pending seeks,
  // re-syncs after a starved read, and opening the device once the current
  // track's format is known while playback is requested.
  void maintenanceOnce() {
    uint32_t rate = 0, ch = 0;
    {
      std::lock_guard<std::mutex> l(mtx);
      for (auto& sp : slots) {
        Slot* s = sp.get();
        if (!s->opened) continue;
        if (s->isStream && !s->decInit && !s->pendingSeek) {
          if (slotProbe(s)) s->needResync = s->posFrames > 0;
        }
        if (s->pendingSeek) {
          if (trySeek(s, s->pendingSeekSec)) s->pendingSeek = false;
        } else if (s->needResync && s->decInit) {
          if (trySeek(s, double(s->posFrames) / std::max(1u, s->sampleRate))) s->needResync = false;
        }
      }
      Slot* c = slots[0].get();
      if (playing && !autoAdvanced && c->opened && c->sampleRate && c->channels &&
          (!devStarted || devRate != c->sampleRate || devChannels != c->channels)) {
        rate = c->sampleRate;
        ch = c->channels;
      }
    }
    if (rate) {
      std::string err = startPlayback(rate, ch);
      if (!err.empty()) QLOG("late device start failed: %s", err.c_str());
    }
  }

  void maintenanceLoop() {
    int tick = 0;
    while (!quit) {
      std::this_thread::sleep_for(std::chrono::milliseconds(20));
      maintenanceOnce();
      if (++tick % 150 == 0) pollDevices();  // every ~3 s
    }
  }

  void pollDevices() {
    std::lock_guard<std::mutex> t(tsfnMtx);
    if (!haveTsfn) return;
    auto list = enumerate();
    std::string sig;
    for (auto& d : list) sig += d.name + "\n";
    if (sig == lastDeviceSig) return;
    lastDeviceSig = sig;
    deviceTsfn.NonBlockingCall([this](Napi::Env env, Napi::Function cb) {
      Napi::Object o = Napi::Object::New(env);
      o.Set("deviceList", deviceListJs(env));
      o.Set("currentDevice", deviceInfoJs(env));
      cb.Call({o});
    });
  }

  Napi::Value deviceListJs(Napi::Env env) {
    auto list = enumerate();
    Napi::Array a = Napi::Array::New(env, list.size());
    for (size_t i = 0; i < list.size(); i++) {
      Napi::Object o = Napi::Object::New(env);
      o.Set("name", list[i].name);
      o.Set("type", backendName);
      a.Set(i, o);
    }
    return a;
  }

  Napi::Value deviceInfoJs(Napi::Env env) {
    std::lock_guard<std::recursive_mutex> d(devMtx);
    Napi::Object o = Napi::Object::New(env);
    o.Set("name", sel.isDefault ? std::string("System default") : sel.name);
    o.Set("type", backendName);
    o.Set("sampleRate", double(devRate.load()));
    o.Set("bitDepth", 32);
    return o;
  }
};

Player* g_player = nullptr;

// ---------------------------------------------------------------- JS API
void resetSlot(Slot* s) {  // JS thread, mtx held
  slotUninitDecoder(s);
  if (!s->bufRef.IsEmpty()) s->bufRef.Reset();
  *s = Slot();
}

Napi::Value Open(const Napi::CallbackInfo& info, bool stream) {
  Napi::Env env = info.Env();
  Player* p = g_player;
  int idx = info[0].ToBoolean().Value() ? 1 : 0;
  std::lock_guard<std::mutex> l(p->mtx);
  if (idx == 1 && p->autoAdvanced) return Napi::Boolean::New(env, false);
  Slot* s = p->slots[idx].get();
  auto keepTime = s->timeRanges, keepData = s->dataRanges;
  resetSlot(s);
  s->ext = info[2].IsString() ? info[2].As<Napi::String>().Utf8Value() : "flac";
  if (stream) {
    if (!info[1].IsBuffer()) return Napi::Boolean::New(env, false);
    auto buf = info[1].As<Napi::Buffer<uint8_t>>();
    s->isStream = true;
    s->bufRef = Napi::Persistent(buf);
    s->data = buf.Data();
    s->size = buf.Length();
    s->samplesHint = info.Length() > 3 && info[3].IsNumber() ? uint64_t(info[3].ToNumber().Int64Value()) : 0;
    s->timeRanges = keepTime;
    s->dataRanges = keepData ? keepData : std::make_shared<RangeSet>();
    s->vmap = {{0, s->size}};
    s->vsize = s->size;
  } else {
    if (!info[1].IsString()) return Napi::Boolean::New(env, false);
    s->path = info[1].As<Napi::String>().Utf8Value();
  }
  s->opened = true;
  if (!slotProbe(s) && !s->isStream) {
    // a stream whose header hasn't arrived is retried by maintenance
    resetSlot(s);
    return Napi::Boolean::New(env, false);
  }
  QLOG("open %s slot=%d %s %u Hz %u ch %u bit, %.1fs", stream ? "stream" : "file", idx,
       s->ext.c_str(), s->sampleRate, s->channels, s->bps, s->durationSec());
  return Napi::Boolean::New(env, true);
}

Napi::Value JsOpen(const Napi::CallbackInfo& i) { return Open(i, false); }
Napi::Value JsOpenStream(const Napi::CallbackInfo& i) { return Open(i, true); }

Napi::Value JsClose(const Napi::CallbackInfo& info) {
  Player* p = g_player;
  bool all = info.Length() > 0 && info[0].IsBoolean();
  bool release = all && info[0].ToBoolean().Value();
  {
    std::lock_guard<std::mutex> l(p->mtx);
    p->playing = false;
    resetSlot(p->slots[0].get());
    if (all || p->autoAdvanced) resetSlot(p->slots[1].get());
    p->autoAdvanced = false;
  }
  p->stopDevice(release);
  return info.Env().Undefined();
}

Napi::Value JsPlay(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Player* p = g_player;
  uint32_t rate, ch;
  {
    std::lock_guard<std::mutex> l(p->mtx);
    Slot* s = p->slots[0].get();
    if (!s->opened) return Napi::String::New(env, "No track opened");
    p->playing = true;
    // format unknown yet (header not buffered): maintenance opens the device
    if (!s->sampleRate || !s->channels) return env.Undefined();
    rate = s->sampleRate;
    ch = s->channels;
  }
  std::string err = p->startPlayback(rate, ch);
  if (!err.empty()) {
    p->playing = false;
    return Napi::String::New(env, err);
  }
  return env.Undefined();
}

Napi::Value JsPause(const Napi::CallbackInfo& info) {
  g_player->playing = false;
  g_player->stopDevice(false);
  return info.Env().Undefined();
}

Napi::Value JsStatus(const Napi::CallbackInfo& info) {
  Player* p = g_player;
  std::lock_guard<std::mutex> l(p->mtx);
  Slot* s = p->slots[0].get();
  const char* st = "Stopped";
  if (s->opened && p->playing) {
    if (s->finished && !p->autoAdvanced) st = "Stopped";
    else if (p->blocked || s->pendingSeek || s->needResync || !s->decInit) st = "Blocked";
    else st = "Playing";
  }
  return Napi::String::New(info.Env(), st);
}

Napi::Value JsVolume(const Napi::CallbackInfo& info) {
  if (info.Length() > 0 && info[0].IsNumber()) {
    double v = info[0].ToNumber().DoubleValue();
    v = std::clamp(v / 100.0, 0.0, 1.0);
    g_player->gain = float(v * v);  // perceptual-ish curve
  }
  return info.Env().Undefined();
}

Napi::Value JsOffset(const Napi::CallbackInfo& info) {
  Player* p = g_player;
  std::lock_guard<std::mutex> l(p->mtx);
  Slot* s = p->slots[0].get();
  if (info.Length() > 0 && info[0].IsNumber()) {
    double sec = info[0].ToNumber().DoubleValue();
    if (p->autoAdvanced || !s->opened) return info.Env().Undefined();
    if (!p->trySeek(s, sec)) {
      s->pendingSeek = true;
      s->pendingSeekSec = sec;
      s->posFrames = secToFrame(sec, s->sampleRate);
      QLOG("seek to %.3fs pending (data not buffered yet)", sec);
    } else {
      s->pendingSeek = false;
      s->needResync = false;
    }
    return info.Env().Undefined();
  }
  if (!s->opened || !s->sampleRate) return Napi::Number::New(info.Env(), 0);
  if (s->finished) return Napi::Number::New(info.Env(), s->durationSec());
  return Napi::Number::New(info.Env(), double(s->posFrames) / s->sampleRate);
}

Napi::Value JsGetAvailableDeviceList(const Napi::CallbackInfo& info) {
  return g_player->deviceListJs(info.Env());
}

Napi::Value JsUseDevice(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Player* p = g_player;
  std::string name = info[0].IsString() ? info[0].As<Napi::String>().Utf8Value() : "";
  auto list = p->enumerate();
  auto it = std::find_if(list.begin(), list.end(), [&](auto& d) { return d.name == name; });
  if (it == list.end()) return Napi::String::New(env, "Device not found");
  bool wasPlaying = p->playing;
  p->playing = false;
  {
    std::lock_guard<std::recursive_mutex> d(p->devMtx);
    p->stopDevice(true);
    p->sel.name = it->name;
    p->sel.isDefault = it->isDefault;
    p->sel.id = it->id;
  }
  QLOG("use device '%s'", name.c_str());
  if (wasPlaying) {
    Napi::Value r = JsPlay(info);
    if (r.IsString()) return r;
  }
  return env.Undefined();
}

Napi::Value JsDeviceInformation(const Napi::CallbackInfo& info) {
  return g_player->deviceInfoJs(info.Env());
}

Napi::Value JsTrackInformation(const Napi::CallbackInfo& info) {
  Player* p = g_player;
  int idx = info.Length() > 0 && info[0].ToBoolean().Value() ? 1 : 0;
  std::lock_guard<std::mutex> l(p->mtx);
  Slot* s = p->slots[idx].get();
  Napi::Object o = Napi::Object::New(info.Env());
  o.Set("duration", s->durationSec() * 1000.0);
  o.Set("sampleRate", double(s->sampleRate));
  o.Set("bitsPerSample", double(s->bps));
  o.Set("bitDepth", double(s->bps));
  o.Set("numChannels", double(s->channels));
  o.Set("lengthInSamples", double(s->totalFrames));
  o.Set("format", s->ext);
  return o;
}

Napi::Value JsHasStreamFinished(const Napi::CallbackInfo& info) {
  Player* p = g_player;
  std::lock_guard<std::mutex> l(p->mtx);
  Slot* s = p->slots[0].get();
  return Napi::Boolean::New(info.Env(), s->opened && s->finished);
}

Napi::Value JsInitCacheRange(const Napi::CallbackInfo& info) {
  Player* p = g_player;
  int idx = info[0].ToBoolean().Value() ? 1 : 0;
  std::lock_guard<std::mutex> l(p->mtx);
  if (idx == 1 && p->autoAdvanced) return info.Env().Undefined();
  Slot* s = p->slots[idx].get();
  if (info[1].IsObject())
    s->timeRanges = CacheRangesWrap::Unwrap(info[1].As<Napi::Object>())->rs;
  if (info[2].IsObject())
    s->dataRanges = CacheRangesWrap::Unwrap(info[2].As<Napi::Object>())->rs;
  return info.Env().Undefined();
}

Napi::Value JsReleaseResources(const Napi::CallbackInfo& info) {
  Player* p = g_player;
  p->playing = false;
  p->stopDevice(true);
  return info.Env().Undefined();
}

Napi::Value JsLookAhead(const Napi::CallbackInfo& info) {
  if (info.Length() > 0 && info[0].IsNumber()) g_player->lookAhead = info[0].ToNumber().DoubleValue();
  return info.Env().Undefined();
}

Napi::Value JsSetDeviceChangedListener(const Napi::CallbackInfo& info) {
  Player* p = g_player;
  if (!info[0].IsFunction()) return info.Env().Undefined();
  std::lock_guard<std::mutex> t(p->tsfnMtx);
  if (p->haveTsfn) p->deviceTsfn.Release();
  p->deviceTsfn = Napi::ThreadSafeFunction::New(info.Env(), info[0].As<Napi::Function>(),
                                                "qobuzDeviceChanged", 0, 1);
  p->deviceTsfn.Unref(info.Env());
  p->haveTsfn = true;
  p->lastDeviceSig.clear();  // force an initial notification on next poll
  return info.Env().Undefined();
}

Napi::Value JsClearNextTrack(const Napi::CallbackInfo& info) {
  Player* p = g_player;
  std::lock_guard<std::mutex> l(p->mtx);
  if (!p->autoAdvanced) resetSlot(p->slots[1].get());
  return info.Env().Undefined();
}

Napi::Value JsSwitchToNext(const Napi::CallbackInfo& info) {
  Player* p = g_player;
  bool reopen = false;
  {
    std::lock_guard<std::mutex> l(p->mtx);
    std::swap(p->slots[0], p->slots[1]);
    resetSlot(p->slots[1].get());
    Slot* s = p->slots[0].get();
    reopen = !p->autoAdvanced && (s->sampleRate != p->devRate || s->channels != p->devChannels);
    p->autoAdvanced = false;
    QLOG("switchToNext (reopen device: %d)", reopen);
  }
  if (reopen) {
    bool wasPlaying = p->playing;
    p->playing = false;
    p->stopDevice(true);
    p->playing = wasPlaying;
  }
  return info.Env().Undefined();
}

Napi::Value JsNewCacheRanges(const Napi::CallbackInfo& info) {
  return CacheRangesWrap::ctor.New({});
}

// ---------------------------------------------------------------- test API
// Only attached when QOBUZ_AUDIO_TEST is set.
Napi::Value TestRender(const Napi::CallbackInfo& info) {
  Player* p = g_player;
  uint32_t frames = info[0].ToNumber().Uint32Value();
  uint32_t ch = p->devChannels;
  auto arr = Napi::Float32Array::New(info.Env(), size_t(frames) * ch);
  if (ch && p->devStarted) p->render(arr.Data(), frames);
  return arr;
}

Napi::Value TestMaintain(const Napi::CallbackInfo& info) {
  g_player->maintenanceOnce();
  if (info.Length() > 0 && info[0].ToBoolean().Value()) g_player->pollDevices();
  return info.Env().Undefined();
}

Napi::Value TestSetReadMargin(const Napi::CallbackInfo& info) {
  g_readMargin = size_t(info[0].ToNumber().Int64Value());
  return info.Env().Undefined();
}

Napi::Value TestSetFakeDevices(const Napi::CallbackInfo& info) {
  Player* p = g_player;
  std::lock_guard<std::mutex> l(p->enumMtx);
  p->fakeDevices.clear();
  p->useFakeDevices = info[0].IsArray();
  if (p->useFakeDevices) {
    auto a = info[0].As<Napi::Array>();
    for (uint32_t i = 0; i < a.Length(); i++)
      p->fakeDevices.push_back(a.Get(i).As<Napi::String>().Utf8Value());
  }
  return info.Env().Undefined();
}

Napi::Value TestState(const Napi::CallbackInfo& info) {
  Player* p = g_player;
  Napi::Env env = info.Env();
  std::lock_guard<std::mutex> l(p->mtx);
  Napi::Object o = Napi::Object::New(env);
  o.Set("autoAdvanced", p->autoAdvanced);
  o.Set("playing", p->playing.load());
  o.Set("devStarted", p->devStarted.load());
  o.Set("devRate", double(p->devRate.load()));
  o.Set("devChannels", double(p->devChannels.load()));
  o.Set("gain", double(p->gain.load()));
  o.Set("lookAhead", p->lookAhead.load());
  o.Set("resyncs", double(p->statResyncs.load()));
  o.Set("starvedReads", double(g_starvedReads.load()));
  Napi::Array sl = Napi::Array::New(env, 2);
  for (int i = 0; i < 2; i++) {
    Slot* s = p->slots[i].get();
    Napi::Object so = Napi::Object::New(env);
    so.Set("opened", s->opened);
    so.Set("decInit", s->decInit);
    so.Set("posFrames", double(s->posFrames));
    so.Set("totalFrames", double(s->totalFrames));
    so.Set("pendingSeek", s->pendingSeek);
    so.Set("needResync", s->needResync);
    so.Set("eof", s->eof);
    so.Set("finished", s->finished);
    so.Set("pieces", double(s->vmap.size()));
    sl.Set(i, so);
  }
  o.Set("slots", sl);
  return o;
}

Napi::Value CreatePlayer(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!g_player) g_player = new Player();
  Napi::Object o = Napi::Object::New(env);
  auto add = [&](const char* n, Napi::Value (*f)(const Napi::CallbackInfo&)) {
    o.Set(n, Napi::Function::New(env, f, n));
  };
  add("open", JsOpen);
  add("openStream", JsOpenStream);
  add("close", JsClose);
  add("play", JsPlay);
  add("pause", JsPause);
  add("status", JsStatus);
  add("volume", JsVolume);
  add("offset", JsOffset);
  add("getAvailableDeviceList", JsGetAvailableDeviceList);
  add("useDevice", JsUseDevice);
  add("deviceInformation", JsDeviceInformation);
  add("trackInformation", JsTrackInformation);
  add("hasStreamFinished", JsHasStreamFinished);
  add("initCacheRange", JsInitCacheRange);
  add("releaseResources", JsReleaseResources);
  add("lookAheadInSeconds", JsLookAhead);
  add("setDeviceChangedListener", JsSetDeviceChangedListener);
  add("clearNextTrack", JsClearNextTrack);
  add("switchToNext", JsSwitchToNext);
  add("newCacheRanges", JsNewCacheRanges);
  if (g_player->testMode) {
    add("__render", TestRender);
    add("__maintain", TestMaintain);
    add("__setReadMargin", TestSetReadMargin);
    add("__setFakeDevices", TestSetFakeDevices);
    add("__state", TestState);
  }
  return o;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  CacheRangesWrap::Init(env);
  // juce.node's export is called as a factory: require("juce.node")()
  Napi::Function factory = Napi::Function::New(env, CreatePlayer, "createPlayer");
  factory.Set("CacheRanges", CacheRangesWrap::ctor.Value());
  return factory;
}

}  // namespace

NODE_API_MODULE(qobuz_audio, Init)
