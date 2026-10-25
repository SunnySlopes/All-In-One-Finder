#include "double_monument_host.h"
#include "fortress_host.h"
#include "lowy_host.h"
#include "map_service.h"
#include "multi_monument_host.h"
#include "river_host.h"
#include "slime_host.h"
#include "witch_host.h"

#include "cubiomes/finders.h"
#include "cubiomes/generator.h"
#include "cubiomes/util.h"

#include <napi.h>

#include <cstring>

uint32_t mapFlags(bool largeBiomes)
{
    uint32_t flags = FORCE_OCEAN_VARIANTS;
    if (largeBiomes) flags |= LARGE_BIOMES;
    return flags;
}

bool readBool(const Napi::Object &args, const char *key)
{
    Napi::Value value = args.Get(key);
    if (value.IsUndefined() || value.IsNull()) return false;
    return value.ToBoolean().Value();
}

int64_t readSeed(const Napi::Value &value, bool allowText)
{
    if (value.IsNumber()) {
        return static_cast<int64_t>(value.As<Napi::Number>().Int64Value());
    }
    if (!value.IsString()) throw Napi::TypeError::New(value.Env(), "bad-seed");
    uint64_t seed = 0;
    if (!parseSeedText(value.As<Napi::String>().Utf8Value(), &seed, allowText))
        throw Napi::Error::New(value.Env(), "bad-seed");
    return static_cast<int64_t>(seed);
}

Napi::Value Versions(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();
    auto list = listMcVersions();
    Napi::Array out = Napi::Array::New(env, list.size());
    for (size_t i = 0; i < list.size(); i++) {
        Napi::Object item = Napi::Object::New(env);
        item.Set("id", list[i].id);
        item.Set("name", list[i].name);
        out.Set(i, item);
    }
    return out;
}

Napi::Value Features(const Napi::CallbackInfo &info)
{
    auto list = listFeatures();
    Napi::Env env = info.Env();
    Napi::Array out = Napi::Array::New(env, list.size());
    for (size_t i = 0; i < list.size(); i++) {
        Napi::Object item = Napi::Object::New(env);
        item.Set("id", list[i].id);
        item.Set("key", list[i].key);
        item.Set("dim", list[i].dim);
        out.Set(i, item);
    }
    return out;
}

Napi::Value RenderTiles(const Napi::CallbackInfo &info)
{
    Napi::Object args = info[0].As<Napi::Object>();
    int mc = args.Get("mc").As<Napi::Number>().Int32Value();
    int dim = args.Get("dim").As<Napi::Number>().Int32Value();
    int y = args.Get("y").As<Napi::Number>().Int32Value();
    int sx = args.Get("sx").As<Napi::Number>().Int32Value();
    int sz = args.Get("sz").As<Napi::Number>().Int32Value();
    bool large = readBool(args, "largeBiomes");
    int64_t seed = readSeed(args.Get("seed"), true);
    Napi::Array requested = args.Get("tiles").As<Napi::Array>();
    if (requested.Length() > 512) throw Napi::Error::New(info.Env(), "too-many-tiles");
    std::vector<TileSpec> tiles;
    tiles.reserve(requested.Length());
    for (uint32_t i = 0; i < requested.Length(); i++) {
        Napi::Object item = requested.Get(i).As<Napi::Object>();
        TileSpec tile;
        tile.scale = item.Get("scale").As<Napi::Number>().Int32Value();
        tile.x = item.Get("x").As<Napi::Number>().Int32Value();
        tile.z = item.Get("z").As<Napi::Number>().Int32Value();
        tile.sx = sx;
        tile.sz = sz;
        tiles.push_back(tile);
    }
    std::vector<TileImage> images;
    renderTiles(mc, static_cast<uint64_t>(seed), dim, mapFlags(large), y, tiles, images);
    const size_t stride = static_cast<size_t>(sx) * static_cast<size_t>(sz) * 4;
    std::vector<uint8_t> packed(images.size() * stride, 0);
    for (size_t i = 0; i < images.size(); i++) {
        if (images[i].rgba.size() == stride)
            std::memcpy(packed.data() + i * stride, images[i].rgba.data(), stride);
    }
    return Napi::Buffer<uint8_t>::Copy(info.Env(), packed.data(), packed.size());
}

Napi::Value SlimeMask(const Napi::CallbackInfo &info)
{
    Napi::Object args = info[0].As<Napi::Object>();
    int cx = args.Get("cx").As<Napi::Number>().Int32Value();
    int cz = args.Get("cz").As<Napi::Number>().Int32Value();
    int width = args.Get("w").As<Napi::Number>().Int32Value();
    int height = args.Get("h").As<Napi::Number>().Int32Value();
    if (width < 1 || height < 1 || width > 2048 || height > 2048)
        throw Napi::Error::New(info.Env(), "bad-size");
    int64_t seed = readSeed(args.Get("seed"), true);
    std::vector<uint8_t> mask;
    slimeMask(static_cast<uint64_t>(seed), cx, cz, width, height, mask);
    return Napi::Buffer<uint8_t>::Copy(info.Env(), mask.data(), mask.size());
}

Napi::Value RenderTile(const Napi::CallbackInfo &info)
{
    Napi::Object args = info[0].As<Napi::Object>();
    int mc = args.Get("mc").As<Napi::Number>().Int32Value();
    int dim = args.Get("dim").As<Napi::Number>().Int32Value();
    int scale = args.Get("scale").As<Napi::Number>().Int32Value();
    int x = args.Get("x").As<Napi::Number>().Int32Value();
    int z = args.Get("z").As<Napi::Number>().Int32Value();
    int sx = args.Get("sx").As<Napi::Number>().Int32Value();
    int sz = args.Get("sz").As<Napi::Number>().Int32Value();
    int y = args.Get("y").As<Napi::Number>().Int32Value();
    bool large = readBool(args, "largeBiomes");
    int64_t seed = readSeed(args.Get("seed"), true);
    std::vector<uint8_t> rgba;
    std::string error;
    if (!renderBiomeTile(mc, static_cast<uint64_t>(seed), dim, mapFlags(large), scale, x, z, sx, sz, y, rgba, error))
        throw Napi::Error::New(info.Env(), error);
    return Napi::Buffer<uint8_t>::Copy(info.Env(), rgba.data(), rgba.size());
}

Napi::Value BiomeAt(const Napi::CallbackInfo &info)
{
    Napi::Object args = info[0].As<Napi::Object>();
    int mc = args.Get("mc").As<Napi::Number>().Int32Value();
    int dim = args.Get("dim").As<Napi::Number>().Int32Value();
    int x = args.Get("x").As<Napi::Number>().Int32Value();
    int y = args.Get("y").As<Napi::Number>().Int32Value();
    int z = args.Get("z").As<Napi::Number>().Int32Value();
    bool large = readBool(args, "largeBiomes");
    int64_t seed = readSeed(args.Get("seed"), true);
    int id = biomeAt(mc, static_cast<uint64_t>(seed), dim, mapFlags(large), x, y, z);
    const char *name = biome2str(mc, id);
    Napi::Object out = Napi::Object::New(info.Env());
    out.Set("id", id);
    out.Set("name", name ? name : "");
    return out;
}

Napi::Object BoxToObject(Napi::Env env, const Box3i &box)
{
    Napi::Object out = Napi::Object::New(env);
    out.Set("minX", box.minX);
    out.Set("minY", box.minY);
    out.Set("minZ", box.minZ);
    out.Set("maxX", box.maxX);
    out.Set("maxY", box.maxY);
    out.Set("maxZ", box.maxZ);
    return out;
}

Napi::Array BoxesToArray(Napi::Env env, const std::vector<Box3i> &boxes)
{
    Napi::Array out = Napi::Array::New(env, boxes.size());
    for (size_t i = 0; i < boxes.size(); i++) out.Set(i, BoxToObject(env, boxes[i]));
    return out;
}

Napi::Value Structures(const Napi::CallbackInfo &info)
{
    Napi::Object args = info[0].As<Napi::Object>();
    int mc = args.Get("mc").As<Napi::Number>().Int32Value();
    int dim = args.Get("dim").As<Napi::Number>().Int32Value();
    int x0 = args.Get("x0").As<Napi::Number>().Int32Value();
    int z0 = args.Get("z0").As<Napi::Number>().Int32Value();
    int x1 = args.Get("x1").As<Napi::Number>().Int32Value();
    int z1 = args.Get("z1").As<Napi::Number>().Int32Value();
    bool large = readBool(args, "largeBiomes");
    int64_t seed = readSeed(args.Get("seed"), true);
    std::vector<int> types;
    Napi::Array requested = args.Get("types").As<Napi::Array>();
    for (uint32_t i = 0; i < requested.Length(); i++)
        types.push_back(requested.Get(i).As<Napi::Number>().Int32Value());
    auto found = featuresInView(mc, static_cast<uint64_t>(seed), dim, mapFlags(large), x0, z0, x1, z1, types);
    Napi::Array out = Napi::Array::New(info.Env(), found.size());
    for (size_t i = 0; i < found.size(); i++) {
        Napi::Object item = Napi::Object::New(info.Env());
        item.Set("type", found[i].type);
        item.Set("x", found[i].x);
        item.Set("z", found[i].z);
        item.Set("variant", found[i].variant);
        if (found[i].hasFrame) {
            item.Set("large", BoxToObject(info.Env(), found[i].large));
            item.Set("pieces", BoxesToArray(info.Env(), found[i].pieces));
        }
        out.Set(i, item);
    }
    return out;
}

Napi::Value StructureBounds(const Napi::CallbackInfo &info)
{
    Napi::Object args = info[0].As<Napi::Object>();
    int mc = args.Get("mc").As<Napi::Number>().Int32Value();
    int type = args.Get("type").As<Napi::Number>().Int32Value();
    int x = args.Get("x").As<Napi::Number>().Int32Value();
    int z = args.Get("z").As<Napi::Number>().Int32Value();
    int64_t seed = readSeed(args.Get("seed"), true);
    if (type != Fortress) return info.Env().Null();

    FortressBounds bounds;
    if (!fortressBounds(mc, static_cast<uint64_t>(seed), x, z, bounds)) return info.Env().Null();

    Napi::Object out = Napi::Object::New(info.Env());
    out.Set("large", BoxToObject(info.Env(), bounds.large));
    out.Set("start", BoxToObject(info.Env(), bounds.start));
    out.Set("small", BoxToObject(info.Env(), bounds.start));
    out.Set("pieces", BoxesToArray(info.Env(), bounds.pieces));
    return out;
}

Napi::Value Weirdness(const Napi::CallbackInfo &info)
{
    int64_t seed = readSeed(info[0], false);
    return Napi::Number::New(info.Env(), lowyWeirdness(seed));
}

Napi::Value Supports(const Napi::CallbackInfo &info)
{
    return Napi::Boolean::New(info.Env(), lowySupports(info[0].As<Napi::Number>().Int32Value()));
}

std::vector<int64_t> readSeeds(Napi::Env env, const Napi::Value &value)
{
    std::vector<int64_t> seeds;
    if (value.IsArray()) {
        Napi::Array arr = value.As<Napi::Array>();
        for (uint32_t i = 0; i < arr.Length(); i++) {
            std::string line = arr.Get(i).As<Napi::String>().Utf8Value();
            uint64_t seed = 0;
            if (parseSeedText(line, &seed, false)) seeds.push_back(static_cast<int64_t>(seed));
        }
        return seeds;
    }
    if (!value.IsString()) throw Napi::TypeError::New(env, "bad-seed");
    std::string text = value.As<Napi::String>().Utf8Value();
    size_t start = 0;
    while (start <= text.size()) {
        size_t end = text.find_first_of("\r\n", start);
        std::string line = text.substr(start, end == std::string::npos ? std::string::npos : end - start);
        uint64_t seed = 0;
        if (parseSeedText(line, &seed, false)) seeds.push_back(static_cast<int64_t>(seed));
        if (end == std::string::npos) break;
        start = end + 1;
    }
    return seeds;
}

Napi::Value SearchStart(const Napi::CallbackInfo &info)
{
    Napi::Object args = info[0].As<Napi::Object>();
    LowyRequest request;
    std::string page = args.Get("page").As<Napi::String>().Utf8Value();
    if (page == "lowy-single") request.mode = 0;
    else if (page == "lowy-list") request.mode = 0;
    else if (page == "lowy-fast") request.mode = 2;
    else throw Napi::Error::New(info.Env(), "unknown-page");
    request.mc = args.Get("mc").As<Napi::Number>().Int32Value();
    request.threads = args.Get("threads").As<Napi::Number>().Int32Value();
    request.minX = args.Get("minX").As<Napi::Number>().Int32Value();
    request.maxX = args.Get("maxX").As<Napi::Number>().Int32Value();
    request.minZ = args.Get("minZ").As<Napi::Number>().Int32Value();
    request.maxZ = args.Get("maxZ").As<Napi::Number>().Int32Value();
    request.fastMode = args.Has("fastMode") ? args.Get("fastMode").As<Napi::Boolean>().Value() : true;
    request.ratioPercent = args.Get("ratio").As<Napi::Number>().FloatValue();
    request.riverWeight = args.Has("riverWeight") ? args.Get("riverWeight").As<Napi::Number>().FloatValue() : 0.75f;
    if (page == "lowy-list") request.seeds = readSeeds(info.Env(), args.Get("seeds"));
    else request.seeds.push_back(readSeed(args.Get("seed"), false));
    std::string error = lowyStart(request);
    if (!error.empty()) throw Napi::Error::New(info.Env(), error);
    return info.Env().Undefined();
}

Napi::Object statusToObject(Napi::Env env, const LowyStatus &status)
{
    Napi::Object out = Napi::Object::New(env);
    out.Set("running", status.running);
    out.Set("done", status.done);
    out.Set("paused", status.paused);
    out.Set("phase", status.phase);
    out.Set("current", status.current);
    out.Set("total", status.total);
    out.Set("seedIndex", status.seedIndex);
    out.Set("seedCount", status.seedCount);
    out.Set("error", status.error);
    constexpr double area = 49640.0; /* 24 < r <= 128 刷怪环的格点总面积 */
    Napi::Array hits = Napi::Array::New(env, status.hits.size());
    for (size_t i = 0; i < status.hits.size(); i++) {
        const auto &hit = status.hits[i];
        Napi::Object item = Napi::Object::New(env);
        item.Set("seed", Napi::BigInt::New(env, hit.seed));
        item.Set("x", hit.x);
        item.Set("z", hit.z);
        item.Set("total", hit.total);
        item.Set("cave", hit.cave);
        item.Set("river", hit.river);
        item.Set("ratio", hit.total / area * 100.0);
        hits.Set(i, item);
    }
    out.Set("hits", hits);
    return out;
}

Napi::Value SearchPoll(const Napi::CallbackInfo &info)
{
    return statusToObject(info.Env(), lowyPoll());
}

Napi::Value SearchPause(const Napi::CallbackInfo &info)
{
    lowyPause();
    return info.Env().Undefined();
}

Napi::Value SearchResume(const Napi::CallbackInfo &info)
{
    lowyResume();
    return info.Env().Undefined();
}

Napi::Value SearchStop(const Napi::CallbackInfo &info)
{
    lowyStop();
    return info.Env().Undefined();
}

Napi::Value SlimeFarmStart(const Napi::CallbackInfo &info)
{
    Napi::Object args = info[0].As<Napi::Object>();
    SlimeRequest request;
    request.mc = args.Get("mc").As<Napi::Number>().Int32Value();
    request.versionRule = args.Has("versionRule") ? args.Get("versionRule").As<Napi::Number>().Int32Value() : 2;
    request.threads = args.Get("threads").As<Napi::Number>().Int32Value();
    request.minSlimeArea = args.Get("minSlimeArea").As<Napi::Number>().Int64Value();
    request.minX = args.Get("minX").As<Napi::Number>().Int32Value();
    request.maxX = args.Get("maxX").As<Napi::Number>().Int32Value();
    request.minZ = args.Get("minZ").As<Napi::Number>().Int32Value();
    request.maxZ = args.Get("maxZ").As<Napi::Number>().Int32Value();
    request.convert = readBool(args, "convert");
    request.seeds = readSeeds(info.Env(), args.Get("seeds"));
    std::string error = slimeStart(request);
    if (!error.empty()) throw Napi::Error::New(info.Env(), error);
    return info.Env().Undefined();
}

Napi::Object slimeStatusToObject(Napi::Env env, const SlimeStatus &status)
{
    Napi::Object out = Napi::Object::New(env);
    out.Set("running", status.running);
    out.Set("done", status.done);
    out.Set("paused", status.paused);
    out.Set("stage", status.stage);
    out.Set("current", Napi::Number::New(env, static_cast<double>(status.current)));
    out.Set("total", Napi::Number::New(env, static_cast<double>(status.total)));
    out.Set("tilesDone", Napi::Number::New(env, static_cast<double>(status.tilesDone)));
    out.Set("tilesTotal", Napi::Number::New(env, static_cast<double>(status.tilesTotal)));
    out.Set("seedIndex", status.seedIndex);
    out.Set("seedCount", status.seedCount);
    out.Set("error", status.error);
    Napi::Array hits = Napi::Array::New(env, status.hits.size());
    for (size_t i = 0; i < status.hits.size(); i++) {
        const auto &hit = status.hits[i];
        Napi::Object item = Napi::Object::New(env);
        item.Set("seed", Napi::BigInt::New(env, hit.seed));
        item.Set("x", Napi::Number::New(env, static_cast<double>(hit.x)));
        item.Set("z", Napi::Number::New(env, static_cast<double>(hit.z)));
        item.Set("area", Napi::Number::New(env, static_cast<double>(hit.area)));
        item.Set("areaEquiv", hit.areaEquiv);
        item.Set("chunks", hit.chunks);
        hits.Set(i, item);
    }
    out.Set("hits", hits);
    return out;
}

Napi::Value SlimeFarmPoll(const Napi::CallbackInfo &info)
{
    return slimeStatusToObject(info.Env(), slimePoll());
}

Napi::Value SlimeFarmPause(const Napi::CallbackInfo &info)
{
    slimePause();
    return info.Env().Undefined();
}

Napi::Value SlimeFarmResume(const Napi::CallbackInfo &info)
{
    slimeResume();
    return info.Env().Undefined();
}

Napi::Value SlimeFarmStop(const Napi::CallbackInfo &info)
{
    slimeStop();
    return info.Env().Undefined();
}

Napi::Value WitchSearchStart(const Napi::CallbackInfo &info)
{
    Napi::Object args = info[0].As<Napi::Object>();
    WitchRequest request;
    request.versionGroup = args.Get("versionGroup").As<Napi::Number>().Int32Value();
    request.largeBiomes = readBool(args, "largeBiomes");
    request.singleBiome = readBool(args, "singleBiome");
    request.threads = args.Get("threads").As<Napi::Number>().Int32Value();
    request.maxY = args.Get("maxY").As<Napi::Number>().Int32Value();
    request.minX = args.Get("minX").As<Napi::Number>().Int32Value();
    request.maxX = args.Get("maxX").As<Napi::Number>().Int32Value();
    request.minZ = args.Get("minZ").As<Napi::Number>().Int32Value();
    request.maxZ = args.Get("maxZ").As<Napi::Number>().Int32Value();
    request.seeds = readSeeds(info.Env(), args.Get("seeds"));
    std::string error = witchStart(request);
    if (!error.empty()) throw Napi::Error::New(info.Env(), error);
    return info.Env().Undefined();
}

Napi::Object witchStatusToObject(Napi::Env env, const WitchStatus &status)
{
    Napi::Object out = Napi::Object::New(env);
    out.Set("running", status.running);
    out.Set("done", status.done);
    out.Set("paused", status.paused);
    out.Set("current", Napi::Number::New(env, static_cast<double>(status.current)));
    out.Set("total", Napi::Number::New(env, static_cast<double>(status.total)));
    out.Set("seedIndex", status.seedIndex);
    out.Set("seedCount", status.seedCount);
    out.Set("error", status.error);
    Napi::Array hits = Napi::Array::New(env, status.hits.size());
    for (size_t i = 0; i < status.hits.size(); i++) {
        const auto &hit = status.hits[i];
        Napi::Object item = Napi::Object::New(env);
        item.Set("seed", Napi::BigInt::New(env, hit.seed));
        item.Set("x", hit.x);
        item.Set("z", hit.z);
        item.Set("y", hit.y);
        item.Set("dir", hit.dir);
        item.Set("sizeX", hit.sizeX);
        item.Set("sizeZ", hit.sizeZ);
        item.Set("wet", hit.wet);
        item.Set("flooded", hit.flooded);
        item.Set("reject", hit.reject);
        hits.Set(i, item);
    }
    out.Set("hits", hits);
    return out;
}

Napi::Value WitchSearchPoll(const Napi::CallbackInfo &info)
{
    return witchStatusToObject(info.Env(), witchPoll());
}

Napi::Value WitchSearchPause(const Napi::CallbackInfo &info)
{
    witchPause();
    return info.Env().Undefined();
}

Napi::Value WitchSearchResume(const Napi::CallbackInfo &info)
{
    witchResume();
    return info.Env().Undefined();
}

Napi::Value WitchSearchStop(const Napi::CallbackInfo &info)
{
    witchStop();
    return info.Env().Undefined();
}

Napi::Value RiverSearchStart(const Napi::CallbackInfo &info)
{
    Napi::Object args = info[0].As<Napi::Object>();
    RiverRequest request;
    request.mc = args.Get("mc").As<Napi::Number>().Int32Value();
    request.threads = args.Get("threads").As<Napi::Number>().Int32Value();
    request.minScore = args.Get("minScore").As<Napi::Number>().Int32Value();
    request.y = args.Get("y").As<Napi::Number>().Int32Value();
    request.calcCave = readBool(args, "calcCave");
    request.minX = args.Get("minX").As<Napi::Number>().Int32Value();
    request.maxX = args.Get("maxX").As<Napi::Number>().Int32Value();
    request.minZ = args.Get("minZ").As<Napi::Number>().Int32Value();
    request.maxZ = args.Get("maxZ").As<Napi::Number>().Int32Value();
    request.seeds = readSeeds(info.Env(), args.Get("seeds"));
    std::string error = riverStart(request);
    if (!error.empty()) throw Napi::Error::New(info.Env(), error);
    return info.Env().Undefined();
}

Napi::Object riverStatusToObject(Napi::Env env, const RiverStatus &status)
{
    Napi::Object out = Napi::Object::New(env);
    out.Set("running", status.running);
    out.Set("done", status.done);
    out.Set("paused", status.paused);
    out.Set("stage", status.stage);
    out.Set("current", Napi::Number::New(env, static_cast<double>(status.current)));
    out.Set("total", Napi::Number::New(env, static_cast<double>(status.total)));
    out.Set("seedIndex", status.seedIndex);
    out.Set("seedCount", status.seedCount);
    out.Set("error", status.error);
    Napi::Array hits = Napi::Array::New(env, status.hits.size());
    for (size_t i = 0; i < status.hits.size(); i++) {
        const auto &hit = status.hits[i];
        Napi::Object item = Napi::Object::New(env);
        item.Set("seed", Napi::BigInt::New(env, hit.seed));
        item.Set("x", hit.x);
        item.Set("z", hit.z);
        item.Set("sampleY", hit.sampleY);
        item.Set("river", hit.river);
        item.Set("cave", hit.cave);
        item.Set("score", hit.score);
        hits.Set(i, item);
    }
    out.Set("hits", hits);
    return out;
}

Napi::Value RiverSearchPoll(const Napi::CallbackInfo &info)
{
    return riverStatusToObject(info.Env(), riverPoll());
}

Napi::Value RiverSearchPause(const Napi::CallbackInfo &info)
{
    riverPause();
    return info.Env().Undefined();
}

Napi::Value RiverSearchResume(const Napi::CallbackInfo &info)
{
    riverResume();
    return info.Env().Undefined();
}

Napi::Value RiverSearchStop(const Napi::CallbackInfo &info)
{
    riverStop();
    return info.Env().Undefined();
}

Napi::Value FortressSearchStart(const Napi::CallbackInfo &info)
{
    Napi::Object args = info[0].As<Napi::Object>();
    FortressRequest request;
    request.mc = args.Get("mc").As<Napi::Number>().Int32Value();
    request.threads = args.Get("threads").As<Napi::Number>().Int32Value();
    request.mode = args.Get("mode").As<Napi::Number>().Int32Value();
    request.crossFilter = args.Has("crossFilter") ? args.Get("crossFilter").As<Napi::Number>().Int32Value() : 2;
    request.minLong = args.Has("minLong") ? args.Get("minLong").As<Napi::Number>().Int32Value() : 0;
    request.minShort = args.Has("minShort") ? args.Get("minShort").As<Napi::Number>().Int32Value() : 0;
    request.minHeight = args.Has("minHeight") ? args.Get("minHeight").As<Napi::Number>().Int32Value() : 16;
    request.minX = args.Get("minX").As<Napi::Number>().Int32Value();
    request.maxX = args.Get("maxX").As<Napi::Number>().Int32Value();
    request.minZ = args.Get("minZ").As<Napi::Number>().Int32Value();
    request.maxZ = args.Get("maxZ").As<Napi::Number>().Int32Value();
    request.seeds = readSeeds(info.Env(), args.Get("seeds"));
    std::string error = fortressStart(request);
    if (!error.empty()) throw Napi::Error::New(info.Env(), error);
    return info.Env().Undefined();
}

Napi::Object fortressStatusToObject(Napi::Env env, const FortressStatus &status)
{
    Napi::Object out = Napi::Object::New(env);
    out.Set("running", status.running);
    out.Set("done", status.done);
    out.Set("paused", status.paused);
    out.Set("current", Napi::Number::New(env, static_cast<double>(status.current)));
    out.Set("total", Napi::Number::New(env, static_cast<double>(status.total)));
    out.Set("seedIndex", status.seedIndex);
    out.Set("seedCount", status.seedCount);
    out.Set("error", status.error);
    Napi::Array hits = Napi::Array::New(env, status.hits.size());
    for (size_t i = 0; i < status.hits.size(); i++) {
        const auto &hit = status.hits[i];
        Napi::Object item = Napi::Object::New(env);
        item.Set("seed", Napi::BigInt::New(env, hit.seed));
        item.Set("x", hit.x);
        item.Set("y", hit.y);
        item.Set("z", hit.z);
        item.Set("crossings", hit.crossings);
        item.Set("spanX", hit.spanX);
        item.Set("spanY", hit.spanY);
        item.Set("spanZ", hit.spanZ);
        item.Set("area", hit.area);
        hits.Set(i, item);
    }
    out.Set("hits", hits);
    return out;
}

Napi::Value FortressSearchPoll(const Napi::CallbackInfo &info)
{
    return fortressStatusToObject(info.Env(), fortressPoll());
}

Napi::Value FortressSearchPause(const Napi::CallbackInfo &info)
{
    fortressPause();
    return info.Env().Undefined();
}

Napi::Value FortressSearchResume(const Napi::CallbackInfo &info)
{
    fortressResume();
    return info.Env().Undefined();
}

Napi::Value FortressSearchStop(const Napi::CallbackInfo &info)
{
    fortressStop();
    return info.Env().Undefined();
}

Napi::Object monumentStatusToObject(Napi::Env env, const MonumentStatus &status)
{
    Napi::Object out = Napi::Object::New(env);
    out.Set("running", status.running);
    out.Set("done", status.done);
    out.Set("paused", status.paused);
    out.Set("current", Napi::Number::New(env, static_cast<double>(status.current)));
    out.Set("total", Napi::Number::New(env, static_cast<double>(status.total)));
    out.Set("seedIndex", status.seedIndex);
    out.Set("seedCount", status.seedCount);
    out.Set("error", status.error);
    Napi::Array hits = Napi::Array::New(env, status.hits.size());
    for (size_t i = 0; i < status.hits.size(); i++) {
        const auto &hit = status.hits[i];
        Napi::Object item = Napi::Object::New(env);
        item.Set("seed", Napi::BigInt::New(env, hit.seed));
        item.Set("x", hit.x);
        item.Set("z", hit.z);
        item.Set("dx", hit.dx);
        item.Set("dz", hit.dz);
        item.Set("count", hit.count);
        item.Set("area", hit.area);
        item.Set("lowEfficiency", hit.lowEfficiency);
        item.Set("oceanType", hit.oceanType);
        hits.Set(i, item);
    }
    out.Set("hits", hits);
    return out;
}

Napi::Value MultiMonumentSearchStart(const Napi::CallbackInfo &info)
{
    Napi::Object args = info[0].As<Napi::Object>();
    MultiMonumentRequest request;
    request.mc = args.Get("mc").As<Napi::Number>().Int32Value();
    request.threads = args.Get("threads").As<Napi::Number>().Int32Value();
    request.level = args.Get("level").As<Napi::Number>().Int32Value();
    request.biomeCheck = readBool(args, "biomeCheck");
    request.minGroupArea = args.Has("minGroupArea") ? args.Get("minGroupArea").As<Napi::Number>().Int32Value() : 6728;
    request.minX = args.Get("minX").As<Napi::Number>().Int32Value();
    request.maxX = args.Get("maxX").As<Napi::Number>().Int32Value();
    request.minZ = args.Get("minZ").As<Napi::Number>().Int32Value();
    request.maxZ = args.Get("maxZ").As<Napi::Number>().Int32Value();
    request.seeds = readSeeds(info.Env(), args.Get("seeds"));
    std::string error = multiMonumentStart(request);
    if (!error.empty()) throw Napi::Error::New(info.Env(), error);
    return info.Env().Undefined();
}

Napi::Value MultiMonumentSearchPoll(const Napi::CallbackInfo &info)
{
    return monumentStatusToObject(info.Env(), multiMonumentPoll());
}

Napi::Value MultiMonumentSearchPause(const Napi::CallbackInfo &info)
{
    multiMonumentPause();
    return info.Env().Undefined();
}

Napi::Value MultiMonumentSearchResume(const Napi::CallbackInfo &info)
{
    multiMonumentResume();
    return info.Env().Undefined();
}

Napi::Value MultiMonumentSearchStop(const Napi::CallbackInfo &info)
{
    multiMonumentStop();
    return info.Env().Undefined();
}

Napi::Value DoubleMonumentSearchStart(const Napi::CallbackInfo &info)
{
    Napi::Object args = info[0].As<Napi::Object>();
    DoubleMonumentRequest request;
    request.mc = args.Get("mc").As<Napi::Number>().Int32Value();
    request.threads = args.Get("threads").As<Napi::Number>().Int32Value();
    request.minX = args.Get("minX").As<Napi::Number>().Int32Value();
    request.maxX = args.Get("maxX").As<Napi::Number>().Int32Value();
    request.minZ = args.Get("minZ").As<Napi::Number>().Int32Value();
    request.maxZ = args.Get("maxZ").As<Napi::Number>().Int32Value();
    request.seeds = readSeeds(info.Env(), args.Get("seeds"));
    std::string error = doubleMonumentStart(request);
    if (!error.empty()) throw Napi::Error::New(info.Env(), error);
    return info.Env().Undefined();
}

Napi::Value DoubleMonumentSearchPoll(const Napi::CallbackInfo &info)
{
    return monumentStatusToObject(info.Env(), doubleMonumentPoll());
}

Napi::Value DoubleMonumentSearchPause(const Napi::CallbackInfo &info)
{
    doubleMonumentPause();
    return info.Env().Undefined();
}

Napi::Value DoubleMonumentSearchResume(const Napi::CallbackInfo &info)
{
    doubleMonumentResume();
    return info.Env().Undefined();
}

Napi::Value DoubleMonumentSearchStop(const Napi::CallbackInfo &info)
{
    doubleMonumentStop();
    return info.Env().Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports)
{
    exports.Set("versions", Napi::Function::New(env, Versions));
    exports.Set("features", Napi::Function::New(env, Features));
    exports.Set("renderTile", Napi::Function::New(env, RenderTile));
    exports.Set("renderTiles", Napi::Function::New(env, RenderTiles));
    exports.Set("slimeMask", Napi::Function::New(env, SlimeMask));
    exports.Set("biomeAt", Napi::Function::New(env, BiomeAt));
    exports.Set("structures", Napi::Function::New(env, Structures));
    exports.Set("structureBounds", Napi::Function::New(env, StructureBounds));
    exports.Set("weirdness", Napi::Function::New(env, Weirdness));
    exports.Set("lowySupports", Napi::Function::New(env, Supports));
    exports.Set("searchStart", Napi::Function::New(env, SearchStart));
    exports.Set("searchPoll", Napi::Function::New(env, SearchPoll));
    exports.Set("searchPause", Napi::Function::New(env, SearchPause));
    exports.Set("searchResume", Napi::Function::New(env, SearchResume));
    exports.Set("searchStop", Napi::Function::New(env, SearchStop));
    exports.Set("slimeFarmStart", Napi::Function::New(env, SlimeFarmStart));
    exports.Set("slimeFarmPoll", Napi::Function::New(env, SlimeFarmPoll));
    exports.Set("slimeFarmPause", Napi::Function::New(env, SlimeFarmPause));
    exports.Set("slimeFarmResume", Napi::Function::New(env, SlimeFarmResume));
    exports.Set("slimeFarmStop", Napi::Function::New(env, SlimeFarmStop));
    exports.Set("witchSearchStart", Napi::Function::New(env, WitchSearchStart));
    exports.Set("witchSearchPoll", Napi::Function::New(env, WitchSearchPoll));
    exports.Set("witchSearchPause", Napi::Function::New(env, WitchSearchPause));
    exports.Set("witchSearchResume", Napi::Function::New(env, WitchSearchResume));
    exports.Set("witchSearchStop", Napi::Function::New(env, WitchSearchStop));
    exports.Set("riverSearchStart", Napi::Function::New(env, RiverSearchStart));
    exports.Set("riverSearchPoll", Napi::Function::New(env, RiverSearchPoll));
    exports.Set("riverSearchPause", Napi::Function::New(env, RiverSearchPause));
    exports.Set("riverSearchResume", Napi::Function::New(env, RiverSearchResume));
    exports.Set("riverSearchStop", Napi::Function::New(env, RiverSearchStop));
    exports.Set("fortressSearchStart", Napi::Function::New(env, FortressSearchStart));
    exports.Set("fortressSearchPoll", Napi::Function::New(env, FortressSearchPoll));
    exports.Set("fortressSearchPause", Napi::Function::New(env, FortressSearchPause));
    exports.Set("fortressSearchResume", Napi::Function::New(env, FortressSearchResume));
    exports.Set("fortressSearchStop", Napi::Function::New(env, FortressSearchStop));
    exports.Set("multiMonumentSearchStart", Napi::Function::New(env, MultiMonumentSearchStart));
    exports.Set("multiMonumentSearchPoll", Napi::Function::New(env, MultiMonumentSearchPoll));
    exports.Set("multiMonumentSearchPause", Napi::Function::New(env, MultiMonumentSearchPause));
    exports.Set("multiMonumentSearchResume", Napi::Function::New(env, MultiMonumentSearchResume));
    exports.Set("multiMonumentSearchStop", Napi::Function::New(env, MultiMonumentSearchStop));
    exports.Set("doubleMonumentSearchStart", Napi::Function::New(env, DoubleMonumentSearchStart));
    exports.Set("doubleMonumentSearchPoll", Napi::Function::New(env, DoubleMonumentSearchPoll));
    exports.Set("doubleMonumentSearchPause", Napi::Function::New(env, DoubleMonumentSearchPause));
    exports.Set("doubleMonumentSearchResume", Napi::Function::New(env, DoubleMonumentSearchResume));
    exports.Set("doubleMonumentSearchStop", Napi::Function::New(env, DoubleMonumentSearchStop));
    return exports;
}

NODE_API_MODULE(allinone, Init)
