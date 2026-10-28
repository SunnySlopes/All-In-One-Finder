// aio-engine.exe - developer driver around allinone.dll (not shipped).
//
// The product runs the same server inside the host: `aio-host.exe --engine`.
// This binary exists so the C ABI and JSON protocol can be exercised from the
// command line and by scripts, without Node/N-API.
//
//   aio-engine --abi
//   aio-engine --call <op> [json]
//   aio-engine --batch <file>      one {"id":N,"op":...,"args":...} per line
//   aio-engine --serve             length-prefixed frames on stdin/stdout
#include <windows.h>

#include <cstdio>
#include <fstream>
#include <string>

#include "aio_capi.h"
#include "engine_server.h"

namespace {

std::wstring exeDir()
{
    wchar_t path[MAX_PATH * 2] = {};
    const DWORD n = GetModuleFileNameW(nullptr, path, static_cast<DWORD>(_countof(path)));
    std::wstring full(path, n);
    const size_t slash = full.find_last_of(L"\\/");
    return slash == std::wstring::npos ? std::wstring(L".") : full.substr(0, slash);
}

} // namespace

int main(int argc, char **argv)
{
    std::wstring dll;
    std::string op;
    std::string args;
    std::string batchPath;
    bool serve = false;
    bool abiOnly = false;

    for (int i = 1; i < argc; ++i)
    {
        const std::string arg = argv[i];
        if (arg == "--serve") serve = true;
        else if (arg == "--abi") abiOnly = true;
        else if (arg == "--batch" && i + 1 < argc) batchPath = argv[++i];
        else if (arg == "--dll" && i + 1 < argc)
        {
            const std::string text = argv[++i];
            dll.assign(text.begin(), text.end());
        }
        else if (arg == "--call" && i + 1 < argc) op = argv[++i];
        else if (!arg.empty() && arg[0] != '-') args = arg;
    }

    if (abiOnly)
    {
        std::printf("%d\n", AIO_ABI_VERSION);
        return 0;
    }

    // The trial searcher writes checkpoints under AIO_DATA_DIR (the Electron host
    // used to set it). Default to <exe dir>\userdata for the standalone driver.
    wchar_t existing[8] = {};
    if (GetEnvironmentVariableW(L"AIO_DATA_DIR", existing, static_cast<DWORD>(_countof(existing))) == 0)
    {
        const std::wstring dir = exeDir() + L"\\userdata";
        CreateDirectoryW(dir.c_str(), nullptr);
        SetEnvironmentVariableW(L"AIO_DATA_DIR", dir.c_str());
    }
    if (!aio::loadEngine(dll.empty() ? (exeDir() + L"\\allinone.dll") : dll)) return 3;

    if (serve) return aio::runServer();

    if (!batchPath.empty())
    {
        std::ifstream input(batchPath, std::ios::binary);
        if (!input)
        {
            std::fwprintf(stderr, L"cannot open %hs\n", batchPath.c_str());
            return 2;
        }
        std::string line;
        while (std::getline(input, line))
        {
            if (!line.empty() && line.back() == '\r') line.pop_back();
            if (line.empty()) continue;
            std::printf("%s\n", aio::handleRequest(line).c_str());
        }
        return 0;
    }

    if (op.empty())
    {
        std::printf("usage: aio-engine --call <op> [json] | --batch <file> | --serve | --abi\n");
        return 2;
    }
    std::printf("%s\n", aio::callOp(op, args).c_str());
    return 0;
}


