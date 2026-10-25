#pragma once

#include "monument_common.h"

#include <stdint.h>

#include <string>
#include <vector>

struct DoubleMonumentRequest {
    int mc = 0;
    int threads = 1;
    int minX = 0;
    int maxX = 0;
    int minZ = 0;
    int maxZ = 0;
    std::vector<int64_t> seeds;
};

std::string doubleMonumentStart(const DoubleMonumentRequest &request);
void doubleMonumentPause();
void doubleMonumentResume();
void doubleMonumentStop();
MonumentStatus doubleMonumentPoll();
