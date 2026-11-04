#pragma once

#include <stdint.h>

#include <string>
#include <vector>

struct LowyHit {
    int64_t seed;
    int x;
    int z;
    int total;
    int cave;
    int river;
};

struct LowyStatus {
    bool running = false;
    bool done = false;
    bool paused = false;
    int phase = 0;
    int current = 0;
    int total = 0;
    int seedIndex = 0;
    int seedCount = 0;
    /** AFK Y resolved for this run (shell centre height, also used by /tp). */
    int afkY = -40;
    /** Display denominator: full shell cell count for the sampled window. */
    int fullArea = 49659;
    std::string error;
    /** "gpu" while the OpenCL coarse backend did the phase-1 noise, "cpu" otherwise. */
    std::string scanBackend = "cpu";
    /** Why the GPU path was skipped ("no-opencl", "no-device", "build-failed:..."). */
    std::string gpuReason;
    /** CL_DEVICE_NAME of the device that ran the coarse scan. */
    std::string gpuDevice;
    std::vector<LowyHit> hits;
};

struct LowyRequest {
    int mode = 0;
    int mc = 0;
    int threads = 1;
    int minX = 0;
    int maxX = 0;
    int minZ = 0;
    int maxZ = 0;
    bool fastMode = true;
    /** Opt-in GPU coarse scan; the engine still gates it by window size / threads. */
    bool allowGpu = false;
    float ratioPercent = 60.f;
    float riverWeight = 0.70f;
    /** Precise layer window (B1): every layer in [yMin, yMax] is sampled. */
    int yMin = -63;
    int yMax = -51;
    /**
     * AFK / player Y of the shell model: the scored region is the 3D shell
     * 24 < distance <= 128 around (result x, afkY, result z).  The AIO panel
     * sends "lowest sampled layer + 23" explicitly; the engine would derive the
     * same value for its AFK_Y_AUTO sentinel.
     */
    int afkY = -40;
    std::vector<int64_t> seeds;
};

bool lowySupports(int mc);
float lowyWeirdness(int64_t seed);
std::string lowyStart(const LowyRequest &request);
void lowyPause();
void lowyResume();
void lowyStop();
LowyStatus lowyPoll();
