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
    if (gOwner != SearchOwner::None) return false;
    gOwner = owner;
    return true;
}

void searchGateRelease(SearchOwner owner)
{
    if (owner == SearchOwner::None) return;
    std::lock_guard<std::mutex> lock(gGateMu);
    if (gOwner == owner) gOwner = SearchOwner::None;
}
