#pragma once

/*
 * 全局搜索互斥：所有搜索器 host 共用同一个闸门。
 *
 * 需求是「同一时间只能有一个搜索任务」，这比单个 host 的 gStatus.running 更高一层：
 * 切 Tab 不停止当前任务，但另一个 host 的 start 必须拿到 busy。
 *
 * 每个 host 的 start() 在参数校验通过后 acquire；后台 job() 结束时（成功 / 停止 /
 * 异常）release。线程创建失败也要 release。
 */

enum class SearchOwner {
    None = 0,
    Cave,
    Slime,
    Witch,
    River,
    Fortress,
    MultiMonument,
    DoubleMonument,
    Flower,
};

/** true = 拿到闸门；false = 已有搜索正在运行。 */
bool searchGateAcquire(SearchOwner owner);

/** 只释放自己持有的闸门（owner 不匹配时什么也不做）。 */
void searchGateRelease(SearchOwner owner);
