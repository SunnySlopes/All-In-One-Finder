#pragma once

#include <cstdint>
#include <mutex>
#include <queue>
#include <vector>

/*
 * 主机侧有界 top-K 结果收集器。
 *
 * 上游 ThreadSafeResults（Thread.h）到达上限后直接丢弃后续结果，并让 full() 返回 true
 * 使搜索跳过昂贵计算；这会把“后扫到但面积更大”的组漏掉。本收集器改为只保留最好的 K 个
 * （面积大者优先，同面积保留离原点更近者），并让 full() 始终为 false，保证每个候选都被
 * 评估、参与淘汰。K 仍由宿主设置（当前 20000），内存有界。
 *
 * 评分口径与最终排序一致：
 *   0 单假人：area，点 (x, z)
 *   1 双假人：area，点 = 两假人连线中点
 *   2 单门：  areaMax，点 = (areaMaxX, areaMaxZ)
 */
template<typename T>
class MmResults
{
public:
    MmResults() : heap_(Worse{0}) {}

    void setLimit(size_t limit)
    {
        std::lock_guard<std::mutex> lock(mutex_);
        limit_ = limit;
    }

    void setScoreMode(int mode)
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (mode_ == mode) return;
        mode_ = mode;
        // 只在搜索开始前调用；换口径时清空并重建堆，避免比较器带着旧口径。
        Heap fresh(Worse{mode_});
        heap_.swap(fresh);
    }

    // 上游用 full() 跳过候选计算；top-K 必须看到所有候选，所以永远不“满”。
    bool full() const { return false; }

    void addResult(const T &res)
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (limit_ == 0 || heap_.size() < limit_) {
            heap_.push(res);
            return;
        }
        if (Worse{mode_}(res, heap_.top())) { // 新的比堆顶（最差）更好
            heap_.pop();
            heap_.push(res);
        }
    }

    void clear()
    {
        std::lock_guard<std::mutex> lock(mutex_);
        while (!heap_.empty()) heap_.pop();
    }

    bool empty() const
    {
        std::lock_guard<std::mutex> lock(mutex_);
        return heap_.empty();
    }

    std::vector<T> peekAll() const
    {
        std::lock_guard<std::mutex> lock(mutex_);
        Heap copy = heap_;
        std::vector<T> out;
        out.reserve(copy.size());
        while (!copy.empty()) {
            out.push_back(copy.top());
            copy.pop();
        }
        return out;
    }

    std::vector<T> getAllResults()
    {
        std::lock_guard<std::mutex> lock(mutex_);
        std::vector<T> out;
        out.reserve(heap_.size());
        while (!heap_.empty()) {
            out.push_back(heap_.top());
            heap_.pop();
        }
        return out;
    }

private:
    struct Worse {
        int mode = 0;

        // 返回 true 表示 a 比 b 更好；priority_queue 顶部因此是最差的那个。
        bool operator()(const T &a, const T &b) const
        {
            const int sa = scoreOf(a, mode);
            const int sb = scoreOf(b, mode);
            if (sa != sb) return sa > sb;
            const int64_t da = distance2Of(a, mode);
            const int64_t db = distance2Of(b, mode);
            if (da != db) return da < db;
            if (a.x != b.x) return a.x < b.x;
            return a.z < b.z;
        }
    };

    using Heap = std::priority_queue<T, std::vector<T>, Worse>;

    static int scoreOf(const T &hit, int mode)
    {
        return mode == 2 ? hit.areaMax : hit.area;
    }

    static int64_t distance2Of(const T &hit, int mode)
    {
        int x = hit.x;
        int z = hit.z;
        if (mode == 1) {
            x = (hit.x + hit.x2) / 2;
            z = (hit.z + hit.z2) / 2;
        } else if (mode == 2) {
            x = hit.areaMaxX;
            z = hit.areaMaxZ;
        }
        return static_cast<int64_t>(x) * x + static_cast<int64_t>(z) * z;
    }

    mutable std::mutex mutex_;
    Heap heap_;
    size_t limit_ = 0;
    int mode_ = 0;
};
