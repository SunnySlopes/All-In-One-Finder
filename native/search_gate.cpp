#include "search_gate.h"

#include <mutex>

namespace {

std::mutex gGateMu;
SearchOwner gOwner = SearchOwner::None;

} // namespace

bool searchGateAcquire(SearchOwner owner)
{
    if (owner == SearchOwner::None) return false;
    std::lock_guard<std::mutex> lock(gGateMu);
    // 可重入：trial 暂停时工作线程已结束，但闸门仍由 Trial 持有；恢复 / 参数
    // 变化后重新 start 时需要再次 acquire，这里对同一 owner 直接放行。
    if (gOwner != SearchOwner::None) return gOwner == owner;
    gOwner = owner;
    return true;
}

void searchGateRelease(SearchOwner owner)
{
    if (owner == SearchOwner::None) return;
    std::lock_guard<std::mutex> lock(gGateMu);
    if (gOwner == owner) gOwner = SearchOwner::None;
}
