#pragma once

#include "monument_common.h"

#include <stdint.h>

#include <string>
#include <vector>

struct MultiMonumentRequest {
    int mc = 0;
    int threads = 1;
    int level = 3; /* 3 或 4 */
    bool biomeCheck = true;
    int minGroupArea = 6728;
    int searchModes = 1; /* 1 单假人 / 2 双假人 / 4 单门 */
    int filterMode = 0;  /* 阈值比较：0 单 / 1 双 / 2 单门 */
    int minX = 0;
    int maxX = 0;
    int minZ = 0;
    int maxZ = 0;
    std::vector<int64_t> seeds;
};

std::string multiMonumentStart(const MultiMonumentRequest &request);
void multiMonumentPause();
void multiMonumentResume();
void multiMonumentStop();
MonumentStatus multiMonumentPoll();
