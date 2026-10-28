#include "engine_server.h"

#include "aio_capi.h"

#include <windows.h>
#include <fcntl.h>
#include <io.h>

#include <cstdint>
#include <cstdio>
#include <cstring>

namespace aio {
namespace {

using CallFn = const char *(STDMETHODCALLTYPE *)(const char *, const char *);
using FreeFn = void(STDMETHODCALLTYPE *)(void *);

CallFn g_call = nullptr;
FreeFn g_free = nullptr;

bool readAll(HANDLE handle, void *data, DWORD size)
{
    auto *bytes = static_cast<uint8_t *>(data);
    while (size)
    {
        DWORD got = 0;
        if (!ReadFile(handle, bytes, size, &got, nullptr) || got == 0) return false;
        bytes += got;
        size -= got;
    }
    return true;
}

bool writeAll(HANDLE handle, const void *data, DWORD size)
{
    const auto *bytes = static_cast<const uint8_t *>(data);
    while (size)
    {
        DWORD written = 0;
        if (!WriteFile(handle, bytes, size, &written, nullptr) || written == 0) return false;
        bytes += written;
        size -= written;
    }
    return true;
}

bool readFrame(std::string &payload)
{
    uint32_t length = 0;
    if (!readAll(GetStdHandle(STD_INPUT_HANDLE), &length, sizeof(length))) return false;
    if (length > 32u * 1024u * 1024u) return false;
    payload.resize(length);
    return length == 0 || readAll(GetStdHandle(STD_INPUT_HANDLE), &payload[0], length);
}

bool writeFrame(const std::string &payload)
{
    const uint32_t length = static_cast<uint32_t>(payload.size());
    return writeAll(GetStdHandle(STD_OUTPUT_HANDLE), &length, sizeof(length)) &&
           writeAll(GetStdHandle(STD_OUTPUT_HANDLE), payload.data(), length);
}

// Requests look like {"id":7,"op":"renderTiles","args":{...}}; the server only
// needs id/op/args, so a tiny scanner avoids a second JSON parser.
// Match the KEY (with the colon), not just the quoted word: a forwarded host
// message also contains channel:"op", which would otherwise be picked as the op.
bool parseRequest(const std::string &request, int64_t &id, std::string &op, std::string &args)
{
    const size_t idPos = request.find("\"id\":");
    if (idPos == std::string::npos) return false;
    id = std::strtoll(request.c_str() + idPos + 5, nullptr, 10);

    const size_t opPos = request.find("\"op\":");
    if (opPos == std::string::npos) return false;
    const size_t opStart = request.find('"', opPos + 5);
    if (opStart == std::string::npos) return false;
    const size_t opEnd = request.find('"', opStart + 1);
    if (opEnd == std::string::npos) return false;
    op = request.substr(opStart + 1, opEnd - opStart - 1);

    args.clear();
    const size_t argsPos = request.find("\"args\":");
    if (argsPos != std::string::npos)
    {
        const size_t size = request.size();
        size_t i = argsPos + 7;
        while (i < size && std::isspace(static_cast<unsigned char>(request[i]))) ++i;
        if (i < size && (request[i] == '{' || request[i] == '['))
        {
            const char openChar = request[i];
            const char closeChar = openChar == '{' ? '}' : ']';
            int depth = 0;
            bool inString = false;
            bool escaped = false;
            for (; i < size; ++i)
            {
                const char c = request[i];
                if (inString)
                {
                    if (escaped) escaped = false;
                    else if (c == '\\') escaped = true;
                    else if (c == '"') inString = false;
                    continue;
                }
                if (c == '"') { inString = true; continue; }
                if (c == openChar) ++depth;
                else if (c == closeChar && --depth == 0)
                {
                    ++i;
                    args = request.substr(argsPos + 7, i - (argsPos + 7));
                    // Trim the whitespace between "args": and the value.
                    const size_t firstQuote = args.find_first_of("{[");
                    if (firstQuote != std::string::npos) args = args.substr(firstQuote);
                    break;
                }
            }
        }
        else if (i < size && request[i] == '"')
        {
            size_t j = i + 1;
            bool escaped = false;
            for (; j < size; ++j)
            {
                const char c = request[j];
                if (escaped) escaped = false;
                else if (c == '\\') escaped = true;
                else if (c == '"') { ++j; break; }
            }
            args = request.substr(i, j - i);
        }
        else
        {
            size_t j = i;
            while (j < size && request[j] != ',' && request[j] != '}') ++j;
            size_t last = j;
            while (last > i && std::isspace(static_cast<unsigned char>(request[last - 1]))) --last;
            args = request.substr(i, last - i);
        }
    }
    return true;
}

// Adds the request id to the envelope produced by aio_call.
std::string withId(const std::string &envelope, int64_t id)
{
    if (envelope.empty() || envelope[0] != '{') return envelope;
    char prefix[48];
    std::snprintf(prefix, sizeof(prefix), "{\"id\":%lld,", static_cast<long long>(id));
    return std::string(prefix) + envelope.substr(1);
}

} // namespace

bool loadEngine(const std::wstring &dllPath)
{
    HMODULE module = LoadLibraryW(dllPath.empty() ? L"allinone.dll" : dllPath.c_str());
    if (!module)
    {
        std::fwprintf(stderr, L"cannot load engine dll (error %lu)\n", GetLastError());
        return false;
    }
    g_call = reinterpret_cast<CallFn>(GetProcAddress(module, "aio_call"));
    g_free = reinterpret_cast<FreeFn>(GetProcAddress(module, "aio_free"));
    auto abi = reinterpret_cast<int(STDMETHODCALLTYPE *)()>(GetProcAddress(module, "aio_abi_version"));
    if (!g_call || !g_free || !abi)
    {
        std::fwprintf(stderr, L"engine dll is missing aio_* exports\n");
        return false;
    }
    if (abi() != AIO_ABI_VERSION)
    {
        std::fwprintf(stderr, L"engine ABI mismatch: dll=%d host=%d\n", abi(), AIO_ABI_VERSION);
        return false;
    }
    return true;
}

std::string callOp(const std::string &op, const std::string &args)
{
    if (!g_call) return std::string("{\"ok\":false,\"error\":\"engine-unavailable\"}");
    const char *result = g_call(op.c_str(), args.empty() ? nullptr : args.c_str());
    if (!result) return std::string("{\"ok\":false,\"error\":\"null-result\"}");
    std::string text(result);
    g_free(const_cast<char *>(result));
    return text;
}

std::string handleRequest(const std::string &request)
{
    int64_t id = 0;
    std::string op;
    std::string args;
    if (!parseRequest(request, id, op, args))
        return "{\"id\":0,\"ok\":false,\"error\":\"bad-request\"}";
    return withId(callOp(op, args), id);
}

int runServer()
{
    _setmode(_fileno(stdin), _O_BINARY);
    writeFrame("{\"ready\":true,\"abi\":1}");
    std::string request;
    while (readFrame(request)) writeFrame(handleRequest(request));
    return 0;
}

} // namespace aio


