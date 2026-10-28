// C ABI implementation: JSON in / JSON out on top of the Napi:: shim.
//
// Deliberately dependency-free (no nlohmann): the host only needs objects, arrays,
// strings, numbers, booleans, null and base64 buffers, and keeping the DLL small
// matters for the 10 MB portable budget.
#include "aio_capi.h"

#include "napi_shim/napi.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <string>
#include <vector>

extern "C" void aio_napi_init(Napi::Env env, Napi::Object exports);

namespace {

using Napi::detail::Node;
using Napi::detail::NodePtr;
using Napi::detail::Type;

Napi::Env g_env;
Napi::Object g_exports;
bool g_ready = false;

void initEngine()
{
    if (g_ready) return;
    g_env = Napi::Env();
    g_exports = Napi::Object::New(g_env);
    aio_napi_init(g_env, g_exports);
    g_ready = true;
}

// ---------------------------------------------------------------------------
// JSON reader
// ---------------------------------------------------------------------------

struct Parser
{
    const char *p = nullptr;
    const char *end = nullptr;

    void ws()
    {
        while (p < end && (*p == ' ' || *p == '\n' || *p == '\r' || *p == '\t')) ++p;
    }

    bool consume(char c)
    {
        ws();
        if (p < end && *p == c)
        {
            ++p;
            return true;
        }
        return false;
    }

    NodePtr parseValue()
    {
        ws();
        if (p >= end) return nullptr;
        switch (*p)
        {
        case '{': return parseObject();
        case '[': return parseArray();
        case '"': return parseString();
        case 't':
            if (end - p >= 4 && std::strncmp(p, "true", 4) == 0)
            {
                p += 4;
                return Napi::detail::makeBool(true);
            }
            return nullptr;
        case 'f':
            if (end - p >= 5 && std::strncmp(p, "false", 5) == 0)
            {
                p += 5;
                return Napi::detail::makeBool(false);
            }
            return nullptr;
        case 'n':
            if (end - p >= 4 && std::strncmp(p, "null", 4) == 0)
            {
                p += 4;
                return Napi::detail::make(Type::Null);
            }
            return nullptr;
        default: return parseNumber();
        }
    }

    NodePtr parseNumber()
    {
        const char *start = p;
        while (p < end && ((*p >= '0' && *p <= '9') || *p == '-' || *p == '+' || *p == '.' || *p == 'e' || *p == 'E'))
            ++p;
        if (p == start) return nullptr;
        const std::string text(start, p);
        char *stop = nullptr;
        const double value = std::strtod(text.c_str(), &stop);
        if (!stop || *stop != '\0') return nullptr;
        return Napi::detail::makeNumber(value);
    }

    static void appendUtf8(std::string &out, uint32_t cp)
    {
        if (cp < 0x80)
        {
            out.push_back(static_cast<char>(cp));
        }
        else if (cp < 0x800)
        {
            out.push_back(static_cast<char>(0xC0 | (cp >> 6)));
            out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
        }
        else if (cp < 0x10000)
        {
            out.push_back(static_cast<char>(0xE0 | (cp >> 12)));
            out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
            out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
        }
        else
        {
            out.push_back(static_cast<char>(0xF0 | (cp >> 18)));
            out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
            out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
            out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
        }
    }

    bool parseHex4(uint32_t &out)
    {
        if (end - p < 4) return false;
        uint32_t value = 0;
        for (int i = 0; i < 4; ++i)
        {
            const char c = p[i];
            uint32_t digit = 0;
            if (c >= '0' && c <= '9') digit = static_cast<uint32_t>(c - '0');
            else if (c >= 'a' && c <= 'f') digit = static_cast<uint32_t>(c - 'a' + 10);
            else if (c >= 'A' && c <= 'F') digit = static_cast<uint32_t>(c - 'A' + 10);
            else return false;
            value = (value << 4) | digit;
        }
        p += 4;
        out = value;
        return true;
    }

    NodePtr parseString()
    {
        if (!consume('"')) return nullptr;
        std::string out;
        while (p < end)
        {
            const char c = *p++;
            if (c == '"') return Napi::detail::makeString(std::move(out));
            if (c != '\\')
            {
                out.push_back(c);
                continue;
            }
            if (p >= end) return nullptr;
            const char esc = *p++;
            switch (esc)
            {
            case '"': out.push_back('"'); break;
            case '\\': out.push_back('\\'); break;
            case '/': out.push_back('/'); break;
            case 'b': out.push_back('\b'); break;
            case 'f': out.push_back('\f'); break;
            case 'n': out.push_back('\n'); break;
            case 'r': out.push_back('\r'); break;
            case 't': out.push_back('\t'); break;
            case 'u':
            {
                uint32_t cp = 0;
                if (!parseHex4(cp)) return nullptr;
                if (cp >= 0xD800 && cp <= 0xDBFF && end - p >= 6 && p[0] == '\\' && p[1] == 'u')
                {
                    const char *save = p;
                    p += 2;
                    uint32_t low = 0;
                    if (parseHex4(low) && low >= 0xDC00 && low <= 0xDFFF)
                        cp = 0x10000 + ((cp - 0xD800) << 10) + (low - 0xDC00);
                    else
                        p = save;
                }
                appendUtf8(out, cp);
                break;
            }
            default: return nullptr;
            }
        }
        return nullptr;
    }

    NodePtr parseArray()
    {
        if (!consume('[')) return nullptr;
        auto node = Napi::detail::makeArray(0);
        ws();
        if (consume(']')) return node;
        while (true)
        {
            NodePtr item = parseValue();
            if (!item) return nullptr;
            node->items.push_back(std::move(item));
            ws();
            if (consume(',')) continue;
            if (consume(']')) return node;
            return nullptr;
        }
    }

    NodePtr parseObject()
    {
        if (!consume('{')) return nullptr;
        auto node = Napi::detail::makeObject();
        ws();
        if (consume('}')) return node;
        while (true)
        {
            ws();
            NodePtr key = parseString();
            if (!key) return nullptr;
            if (!consume(':')) return nullptr;
            NodePtr value = parseValue();
            if (!value) return nullptr;
            node->fields.emplace_back(key->text, std::move(value));
            ws();
            if (consume(',')) continue;
            if (consume('}')) return node;
            return nullptr;
        }
    }
};

NodePtr parseJson(const char *text)
{
    if (!text) return nullptr;
    Parser parser;
    parser.p = text;
    parser.end = text + std::strlen(text);
    NodePtr node = parser.parseValue();
    if (!node) return nullptr;
    parser.ws();
    if (parser.p != parser.end) return nullptr;
    return node;
}

// ---------------------------------------------------------------------------
// JSON writer + base64
// ---------------------------------------------------------------------------

void writeEscaped(const std::string &value, std::string &out)
{
    out.push_back('"');
    for (const unsigned char c : value)
    {
        switch (c)
        {
        case '"': out += "\\\""; break;
        case '\\': out += "\\\\"; break;
        case '\b': out += "\\b"; break;
        case '\f': out += "\\f"; break;
        case '\n': out += "\\n"; break;
        case '\r': out += "\\r"; break;
        case '\t': out += "\\t"; break;
        default:
            if (c < 0x20)
            {
                char buf[8];
                std::snprintf(buf, sizeof(buf), "\\u%04x", c);
                out += buf;
            }
            else
            {
                out.push_back(static_cast<char>(c));
            }
        }
    }
    out.push_back('"');
}

void writeNumber(double value, std::string &out)
{
    if (!std::isfinite(value))
    {
        out += "null";
        return;
    }
    char buf[40];
    if (value == std::trunc(value) && std::fabs(value) < 9.0e15)
        std::snprintf(buf, sizeof(buf), "%lld", static_cast<long long>(value));
    else
        std::snprintf(buf, sizeof(buf), "%.17g", value);
    out += buf;
}

const char kBase64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

std::string base64Encode(const uint8_t *data, size_t size)
{
    std::string out;
    out.reserve((size + 2) / 3 * 4);
    size_t i = 0;
    for (; i + 2 < size; i += 3)
    {
        const uint32_t chunk = (static_cast<uint32_t>(data[i]) << 16) |
                               (static_cast<uint32_t>(data[i + 1]) << 8) |
                               static_cast<uint32_t>(data[i + 2]);
        out.push_back(kBase64[(chunk >> 18) & 0x3F]);
        out.push_back(kBase64[(chunk >> 12) & 0x3F]);
        out.push_back(kBase64[(chunk >> 6) & 0x3F]);
        out.push_back(kBase64[chunk & 0x3F]);
    }
    if (i + 1 == size)
    {
        const uint32_t chunk = static_cast<uint32_t>(data[i]) << 16;
        out.push_back(kBase64[(chunk >> 18) & 0x3F]);
        out.push_back(kBase64[(chunk >> 12) & 0x3F]);
        out += "==";
    }
    else if (i + 2 == size)
    {
        const uint32_t chunk = (static_cast<uint32_t>(data[i]) << 16) |
                               (static_cast<uint32_t>(data[i + 1]) << 8);
        out.push_back(kBase64[(chunk >> 18) & 0x3F]);
        out.push_back(kBase64[(chunk >> 12) & 0x3F]);
        out.push_back(kBase64[(chunk >> 6) & 0x3F]);
        out.push_back('=');
    }
    return out;
}

void writeJson(const NodePtr &node, std::string &out)
{
    if (!node)
    {
        out += "null";
        return;
    }
    switch (node->type)
    {
    case Type::Undefined:
    case Type::Null: out += "null"; break;
    case Type::Boolean: out += node->boolean ? "true" : "false"; break;
    case Type::Number: writeNumber(node->number, out); break;
    case Type::String: writeEscaped(node->text, out); break;
    // Seeds travel as decimal strings: JS would lose precision above 2^53.
    case Type::BigInt:
    {
        char buf[32];
        std::snprintf(buf, sizeof(buf), "%lld", static_cast<long long>(node->bigint));
        writeEscaped(buf, out);
        break;
    }
    case Type::Array:
    {
        out.push_back('[');
        for (size_t i = 0; i < node->items.size(); ++i)
        {
            if (i) out.push_back(',');
            writeJson(node->items[i], out);
        }
        out.push_back(']');
        break;
    }
    case Type::Object:
    {
        out.push_back('{');
        for (size_t i = 0; i < node->fields.size(); ++i)
        {
            if (i) out.push_back(',');
            writeEscaped(node->fields[i].first, out);
            out.push_back(':');
            writeJson(node->fields[i].second, out);
        }
        out.push_back('}');
        break;
    }
    case Type::Buffer:
        writeEscaped(base64Encode(node->bytes.data(), node->bytes.size()), out);
        break;
    case Type::Function: out += "null"; break;
    }
}

std::string errorEnvelope(const std::string &message)
{
    std::string out = "{\"ok\":false,\"error\":";
    writeEscaped(message, out);
    out.push_back('}');
    return out;
}

char *duplicate(const std::string &text)
{
    char *buffer = static_cast<char *>(std::malloc(text.size() + 1));
    if (!buffer) return nullptr;
    std::memcpy(buffer, text.c_str(), text.size() + 1);
    return buffer;
}

} // namespace

extern "C" const char *aio_call(const char *op, const char *json_args)
{
    std::string out;
    try
    {
        initEngine();
        if (!op || !*op) return duplicate(errorEnvelope("unknown-op"));

        Napi::Value candidate = g_exports.Get(op);
        if (!candidate.IsFunction()) return duplicate(errorEnvelope(std::string("unknown-op:") + op));

        std::vector<Napi::Value> args;
        if (json_args && *json_args)
        {
            NodePtr parsed = parseJson(json_args);
            if (!parsed) return duplicate(errorEnvelope("bad-json"));
            if (parsed->type != Type::Undefined) args.emplace_back(parsed);
        }

        Napi::Function function = candidate.As<Napi::Function>();
        Napi::CallbackInfo info(g_env, std::move(args));
        Napi::Value result = function.Call(info);

        if (result.IsBuffer())
        {
            const auto &node = result.node();
            out = "{\"ok\":true,\"bin\":\"";
            out += base64Encode(node->bytes.data(), node->bytes.size());
            out += "\"}";
        }
        else
        {
            out = "{\"ok\":true,\"result\":";
            writeJson(result.node(), out);
            out.push_back('}');
        }
    }
    catch (const Napi::Error &error)
    {
        out = errorEnvelope(error.Message());
    }
    catch (const std::exception &error)
    {
        out = errorEnvelope(error.what());
    }
    catch (...)
    {
        out = errorEnvelope("native-exception");
    }
    return duplicate(out);
}

extern "C" void aio_free(void *ptr)
{
    std::free(ptr);
}

extern "C" int aio_abi_version(void)
{
    return AIO_ABI_VERSION;
}
