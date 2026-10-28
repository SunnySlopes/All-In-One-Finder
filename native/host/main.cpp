// All-In-One Finder 闂?WebView2 host (M2).
//
// Replaces Electron: window + virtual host + window.aio bridge + file dialogs +
// session storage + menu + single instance, with the C engine in a child process
// (aio-engine.exe --serve, length-prefixed JSON on anonymous pipes).
//
// Args: --portable-dir <dir>  --dist <dir>  --web <dir>  --dev <url>  --smoke
// Console subsystem for now (M3 switches to WIN32 + file logging).
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <objbase.h>
#include <commdlg.h>
#include <shellapi.h>
#include <shlobj.h>

#include <WebView2.h>

#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cstdarg>
#include <cstring>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include "com_ptr.h"
#include "engine_server.h"
#include "version.h"

// shell32: stable taskbar identity so the pinned/taskbar icon is ours, not a generic one.
extern "C" HRESULT WINAPI SetCurrentProcessExplicitAppUserModelID(PCWSTR appId);

namespace {

constexpr wchar_t kWindowClass[] = L"AioHostWindow";
constexpr wchar_t kWindowTitle[] = L"All-In-One Finder";
constexpr wchar_t kVirtualHost[] = L"app.local";

constexpr UINT kSmokeTimer = 1;
constexpr UINT kSmokeTimeoutMs = 30000;
constexpr UINT kSessionTimer = 2;
constexpr UINT kSessionIntervalMs = 5000;
constexpr UINT WM_APP_ENGINE = WM_APP + 1;

constexpr int ID_IMPORT = 1001;
constexpr int ID_EXPORT = 1002;
constexpr int ID_EXIT = 1003;
constexpr int ID_ABOUT = 1004;

constexpr wchar_t kSessionFilter[] =
    L"Session\0*.json;*.txt\0JSON\0*.json\0Text\0*.txt\0\0";
constexpr wchar_t kTextFilter[] = L"Text\0*.txt;*.csv\0All files\0*.*\0\0";

struct Config
{
    std::wstring exeDir;
    std::wstring portableDir;
    std::wstring distDir;
    std::wstring webDir;
    std::wstring hostExe;
    std::wstring dllPath;
    bool engine = false;
    bool verbose = false;
    std::wstring devUrl;
    bool smoke = false;
};

Config g_config;
HWND g_hwnd = nullptr;
bool g_smokeDone = false;
int g_exitCode = 0; // normal window close exits 0; failures set an explicit code
bool g_tempProfileTried = false; /* one retry with a profile under %TEMP% */
bool g_closeSavePending = false;

aio::ComPtr<ICoreWebView2Environment> g_env;aio::ComPtr<ICoreWebView2Controller> g_controller;
aio::ComPtr<ICoreWebView2> g_webview;

HANDLE g_engineIn = nullptr;
HANDLE g_engineOut = nullptr;
HANDLE g_engineProcess = nullptr;
std::thread g_reader;
std::mutex g_writeMutex;
std::atomic<bool> g_stopping{false};

std::wstring g_sessionDir;
std::wstring g_userDataDir;


// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

std::string wideToUtf8(const std::wstring &text)
{
    if (text.empty()) return {};
    const int size = WideCharToMultiByte(CP_UTF8, 0, text.c_str(), static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr);
    std::string out(static_cast<size_t>(size), '\0');
    WideCharToMultiByte(CP_UTF8, 0, text.c_str(), static_cast<int>(text.size()), out.data(), size, nullptr, nullptr);
    return out;
}

std::wstring utf8ToWide(const std::string &text)
{
    if (text.empty()) return {};
    const int size = MultiByteToWideChar(CP_UTF8, 0, text.c_str(), static_cast<int>(text.size()), nullptr, 0);
    std::wstring out(static_cast<size_t>(size), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, text.c_str(), static_cast<int>(text.size()), out.data(), size);
    return out;
}

std::wstring joinPath(const std::wstring &a, const std::wstring &b)
{
    if (a.empty()) return b;
    if (a.back() == L'\\' || a.back() == L'/') return a + b;
    return a + L"\\" + b;
}

std::wstring absolutePath(const std::wstring &path)
{
    if (path.empty()) return path;
    const DWORD needed = GetFullPathNameW(path.c_str(), 0, nullptr, nullptr);
    if (!needed) return path;
    std::wstring out(needed, L'\0');
    const DWORD written = GetFullPathNameW(path.c_str(), needed, out.data(), nullptr);
    if (!written) return path;
    out.resize(written);
    while (out.size() > 3 && (out.back() == L'\\' || out.back() == L'/')) out.pop_back();
    return out;
}
std::wstring exePath()
{
    wchar_t path[MAX_PATH * 2] = {};
    const DWORD n = GetModuleFileNameW(nullptr, path, static_cast<DWORD>(_countof(path)));
    return std::wstring(path, n);
}

std::wstring exeDir()
{
    const std::wstring full = exePath();
    const size_t slash = full.find_last_of(L"\\/");
    return slash == std::wstring::npos ? std::wstring(L".") : full.substr(0, slash);
}

// Creates the directory and any missing parents (the %LOCALAPPDATA% fallback may
// not have its per-app folder yet).
bool ensureDir(const std::wstring &dir)
{
    if (dir.size() < 3) return false;
    if (GetFileAttributesW(dir.c_str()) != INVALID_FILE_ATTRIBUTES) return true;
    const size_t slash = dir.find_last_of(L"\\/");
    if (slash != std::wstring::npos && slash > 2) ensureDir(dir.substr(0, slash));
    if (CreateDirectoryW(dir.c_str(), nullptr) != FALSE) return true;
    return GetLastError() == ERROR_ALREADY_EXISTS;
}

/** A directory that exists is not necessarily writable; probe with a real file. */
bool writableDir(const std::wstring &dir)
{
    if (!ensureDir(dir)) return false;
    const std::wstring probe =
        joinPath(dir, L".aio-write-probe-" + std::to_wstring(GetCurrentProcessId()) + L".tmp");
    HANDLE file = CreateFileW(probe.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS,
                              FILE_ATTRIBUTE_TEMPORARY | FILE_FLAG_DELETE_ON_CLOSE, nullptr);
    if (file == INVALID_HANDLE_VALUE) return false;
    CloseHandle(file);
    return true;
}

bool readFileBytes(const std::wstring &path, std::string &out)
{
    std::ifstream file(path.c_str(), std::ios::binary);
    if (!file) return false;
    std::ostringstream buffer;
    buffer << file.rdbuf();
    out = buffer.str();
    return true;
}

bool writeFileBytes(const std::wstring &path, const std::string &data, bool createParents)
{
    if (createParents)
    {
        const size_t slash = path.find_last_of(L"\\/");
        if (slash != std::wstring::npos) ensureDir(path.substr(0, slash));
    }
    // Write a sibling temp file and replace atomically: closing the app mid-write
    // must not leave a truncated session file that fails to parse on next launch.
    const std::wstring temporary = path + L".tmp";
    {
        std::ofstream file(temporary.c_str(), std::ios::binary | std::ios::trunc);
        if (!file) return false;
        file.write(data.data(), static_cast<std::streamsize>(data.size()));
        file.flush();
        if (!file)
        {
            file.close();
            DeleteFileW(temporary.c_str());
            return false;
        }
        file.close();
    }
    if (!MoveFileExW(temporary.c_str(), path.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
    {
        DeleteFileW(temporary.c_str());
        return false;
    }
    return true;
}

const char kB64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

std::string base64Encode(const std::string &data)
{
    std::string out;
    out.reserve((data.size() + 2) / 3 * 4);
    size_t i = 0;
    for (; i + 2 < data.size(); i += 3)
    {
        const uint32_t n = (static_cast<uint8_t>(data[i]) << 16) | (static_cast<uint8_t>(data[i + 1]) << 8) |
                           static_cast<uint8_t>(data[i + 2]);
        out.push_back(kB64[(n >> 18) & 63]);
        out.push_back(kB64[(n >> 12) & 63]);
        out.push_back(kB64[(n >> 6) & 63]);
        out.push_back(kB64[n & 63]);
    }
    if (i + 1 == data.size())
    {
        const uint32_t n = static_cast<uint8_t>(data[i]) << 16;
        out.push_back(kB64[(n >> 18) & 63]);
        out.push_back(kB64[(n >> 12) & 63]);
        out += "==";
    }
    else if (i + 2 == data.size())
    {
        const uint32_t n = (static_cast<uint8_t>(data[i]) << 16) | (static_cast<uint8_t>(data[i + 1]) << 8);
        out.push_back(kB64[(n >> 18) & 63]);
        out.push_back(kB64[(n >> 12) & 63]);
        out.push_back(kB64[(n >> 6) & 63]);
        out.push_back('=');
    }
    return out;
}

int base64Value(char c)
{
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
}

std::string base64Decode(const std::string &text)
{
    std::string out;
    out.reserve(text.size() * 3 / 4 + 3);
    int buffer = 0;
    int bits = 0;
    for (const char c : text)
    {
        const int value = base64Value(c);
        if (value < 0) continue;
        buffer = (buffer << 6) | value;
        bits += 6;
        if (bits >= 8)
        {
            bits -= 8;
            out.push_back(static_cast<char>((buffer >> bits) & 0xFF));
        }
    }
    return out;
}

std::string jsonField(const std::string &json, const char *key)
{
    const std::string needle = std::string("\"") + key + "\":\"";
    const size_t start = json.find(needle);
    if (start == std::string::npos) return {};
    const size_t value = start + needle.size();
    const size_t end = json.find('"', value);
    return end == std::string::npos ? std::string() : json.substr(value, end - value);
}

long long jsonIntField(const std::string &json, const char *key)
{
    const std::string needle = std::string("\"") + key + "\":";
    const size_t start = json.find(needle);
    if (start == std::string::npos) return 0;
    return std::strtoll(json.c_str() + start + needle.size(), nullptr, 10);
}

std::wstring b64ToWide(const std::string &b64) { return utf8ToWide(base64Decode(b64)); }
std::string wideToB64(const std::wstring &text) { return base64Encode(wideToUtf8(text)); }

// ---------------------------------------------------------------------------
// WebView2 loader is resolved dynamically: the SDK only ships an MSVC import library.
using CreateEnvFn = HRESULT(STDMETHODCALLTYPE *)(PCWSTR, PCWSTR, ICoreWebView2EnvironmentOptions *,
                                                 ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler *);
using GetVersionFn = HRESULT(STDMETHODCALLTYPE *)(PCWSTR, LPWSTR *);
CreateEnvFn g_createEnv = nullptr;

bool loadWebView2Loader()
{
    const std::wstring local = joinPath(exeDir(), L"WebView2Loader.dll");
    HMODULE module = LoadLibraryW(local.c_str());
    if (!module) module = LoadLibraryW(L"WebView2Loader.dll");
    if (!module) return false;
    g_createEnv = reinterpret_cast<CreateEnvFn>(GetProcAddress(module, "CreateCoreWebView2EnvironmentWithOptions"));
    auto version = reinterpret_cast<GetVersionFn>(GetProcAddress(module, "GetAvailableCoreWebView2BrowserVersionString"));
    if (!g_createEnv || !version) return false;
    LPWSTR runtime = nullptr;
    if (FAILED(version(nullptr, &runtime)) || !runtime) return false;
    std::fwprintf(stdout, L"[host] WebView2 Runtime %ls\n", runtime);
    std::fflush(stdout);
    CoTaskMemFree(runtime);
    return true;
}

// Engine child process
// ---------------------------------------------------------------------------

bool readExact(HANDLE handle, void *data, DWORD size)
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

bool writeExact(HANDLE handle, const void *data, DWORD size)
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

bool readFrame(HANDLE handle, std::string &payload)
{
    uint32_t length = 0;
    if (!readExact(handle, &length, sizeof(length))) return false;
    if (length > 32u * 1024u * 1024u) return false;
    payload.resize(length);
    return length == 0 || readExact(handle, &payload[0], length);
}

bool writeFrame(HANDLE handle, const std::string &payload)
{
    const uint32_t length = static_cast<uint32_t>(payload.size());
    return writeExact(handle, &length, sizeof(length)) && writeExact(handle, payload.data(), length);
}

void readerLoop()
{
    std::string frame;
    while (!g_stopping && readFrame(g_engineOut, frame))
    {
        if (!g_stopping && IsWindow(g_hwnd))
            PostMessageW(g_hwnd, WM_APP_ENGINE, 0, reinterpret_cast<LPARAM>(new std::string(std::move(frame))));
    }
}

bool startEngine()
{
    SECURITY_ATTRIBUTES attributes = {};
    attributes.nLength = sizeof(attributes);
    attributes.bInheritHandle = TRUE;

    HANDLE childInRead = nullptr;
    HANDLE childInWrite = nullptr;
    HANDLE childOutRead = nullptr;
    HANDLE childOutWrite = nullptr;
    if (!CreatePipe(&childInRead, &childInWrite, &attributes, 0)) return false;
    if (!CreatePipe(&childOutRead, &childOutWrite, &attributes, 0)) return false;
    SetHandleInformation(childInWrite, HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation(childOutRead, HANDLE_FLAG_INHERIT, 0);

    STARTUPINFOW startup = {};
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = childInRead;
    startup.hStdOutput = childOutWrite;
    startup.hStdError = childOutWrite;
    PROCESS_INFORMATION process = {};
    std::wstring command = L"\"" + g_config.hostExe + L"\" --engine";
    const BOOL ok = CreateProcessW(g_config.hostExe.c_str(), command.data(), nullptr, nullptr, TRUE,
                                   CREATE_NO_WINDOW, nullptr, g_config.exeDir.c_str(), &startup, &process);
    CloseHandle(childInRead);
    CloseHandle(childOutWrite);
    if (!ok)
    {
        CloseHandle(childInWrite);
        CloseHandle(childOutRead);
        return false;
    }
    g_engineIn = childInWrite;
    g_engineOut = childOutRead;
    g_engineProcess = process.hProcess;
    CloseHandle(process.hThread);

    std::string ready;
    if (!readFrame(g_engineOut, ready) || ready.find("\"ready\":true") == std::string::npos)
    {
        return false;
    }
    g_reader = std::thread(readerLoop);
    return true;
}

void stopEngine()
{
    g_stopping = true;
    if (g_engineIn)
    {
        CloseHandle(g_engineIn);
        g_engineIn = nullptr;
    }
    if (g_reader.joinable()) g_reader.join();
    if (g_engineOut)
    {
        CloseHandle(g_engineOut);
        g_engineOut = nullptr;
    }
    if (g_engineProcess)
    {
        TerminateProcess(g_engineProcess, 0);
        CloseHandle(g_engineProcess);
        g_engineProcess = nullptr;
    }
}

bool sendEngine(const std::string &request)
{
    std::lock_guard<std::mutex> lock(g_writeMutex);
    if (!g_engineIn) return false;
    return writeFrame(g_engineIn, request);
}

// ---------------------------------------------------------------------------
// Host -> page messages
// ---------------------------------------------------------------------------

void postRaw(const std::string &json)
{
    if (!g_webview) return;
    const std::wstring wide = utf8ToWide(json);
    g_webview->PostWebMessageAsJson(wide.c_str());
}

void replyResult(long long id, bool value)
{
    postRaw("{\"id\":" + std::to_string(id) + ",\"ok\":true,\"result\":" + (value ? "true" : "false") + "}");
}

void replyNull(long long id)
{
    postRaw("{\"id\":" + std::to_string(id) + ",\"ok\":true,\"result\":null}");
}

void replyText(long long id, const std::string &text)
{
    postRaw("{\"id\":" + std::to_string(id) + ",\"ok\":true,\"b64\":\"" + base64Encode(text) + "\"}");
}

void replyError(long long id, const char *message)
{
    postRaw("{\"id\":" + std::to_string(id) + ",\"ok\":false,\"error\":\"" + std::string(message) + "\"}");
}

void postEvent(const char *name, const std::string &textB64 = std::string())
{
    std::string json = std::string("{\"event\":\"") + name + "\"";
    if (!textB64.empty()) json += ",\"textB64\":\"" + textB64 + "\"";
    json += "}";
    postRaw(json);
}

// ---------------------------------------------------------------------------
// Dialogs + session storage
// ---------------------------------------------------------------------------

bool pickOpenFile(std::wstring &out, const wchar_t *filter)
{
    wchar_t path[MAX_PATH] = {};
    OPENFILENAMEW dialog = {};
    dialog.lStructSize = sizeof(dialog);
    dialog.hwndOwner = g_hwnd;
    dialog.lpstrFilter = filter;
    dialog.lpstrFile = path;
    dialog.nMaxFile = static_cast<DWORD>(_countof(path));
    dialog.Flags = OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR;
    if (!GetOpenFileNameW(&dialog))
    {
        if (g_config.verbose)
        {
            std::fwprintf(stderr, L"[host] GetOpenFileName failed (commdlg=0x%08lX)\n",
                          static_cast<unsigned long>(CommDlgExtendedError()));
            std::fflush(stderr);
        }
        return false;
    }
    out = path;
    return true;
}

bool pickSaveFile(std::wstring &out, const wchar_t *filter, const wchar_t *extension, const std::wstring &suggested)
{
    wchar_t path[MAX_PATH] = {};
    wcsncpy_s(path, suggested.c_str(), _TRUNCATE);
    OPENFILENAMEW dialog = {};
    dialog.lStructSize = sizeof(dialog);
    dialog.hwndOwner = g_hwnd;
    dialog.lpstrFilter = filter;
    dialog.lpstrFile = path;
    dialog.nMaxFile = static_cast<DWORD>(_countof(path));
    dialog.lpstrDefExt = extension;
    dialog.Flags = OFN_OVERWRITEPROMPT | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR;
    if (!GetSaveFileNameW(&dialog))
    {
        if (g_config.verbose)
        {
            std::fwprintf(stderr, L"[host] GetSaveFileName failed (commdlg=0x%08lX)\n",
                          static_cast<unsigned long>(CommDlgExtendedError()));
            std::fflush(stderr);
        }
        return false;
    }
    out = path;
    return true;
}

std::wstring sessionFile(const std::wstring &name)
{
    std::wstring safe;
    for (const wchar_t c : name)
        safe.push_back((c >= L'a' && c <= L'z') || (c >= L'A' && c <= L'Z') || (c >= L'0' && c <= L'9') ||
                               c == L'.' || c == L'_' || c == L'-'
                           ? c
                           : L'_');
    if (safe.empty()) safe = L"map";
    return joinPath(g_sessionDir, safe + L".json");
}

// ---------------------------------------------------------------------------
// window.aio handlers
// ---------------------------------------------------------------------------

void handleAio(const std::string &message, long long id)
{
    const std::string method = jsonField(message, "method");
    if (g_config.verbose) { std::fwprintf(stderr, L"[aio] %hs\n", method.c_str()); std::fflush(stderr); }
    if (method == "set-title")
    {
        const std::wstring title = b64ToWide(jsonField(message, "titleB64"));
        if (!title.empty() && g_hwnd) SetWindowTextW(g_hwnd, title.c_str());
        return;
    }
    if (method == "open-file")
    {
        std::wstring path;
        std::string text;
        if (pickOpenFile(path, kTextFilter) && readFileBytes(path, text)) replyText(id, text);
        else replyNull(id);
        return;
    }
    if (method == "save-file")
    {
        const std::wstring name = b64ToWide(jsonField(message, "nameB64"));
        const std::string text = base64Decode(jsonField(message, "textB64"));
        std::wstring path;
        const bool ok = pickSaveFile(path, kTextFilter, L"txt", name.empty() ? L"results.txt" : name) &&
                        writeFileBytes(path, text, false);
        replyResult(id, ok);
        return;
    }
    if (method == "read-session")
    {
        const std::wstring name = b64ToWide(jsonField(message, "nameB64"));
        std::string text;
        if (!name.empty() && readFileBytes(sessionFile(name), text)) replyText(id, text);
        else replyNull(id);
        return;
    }
    if (method == "write-session")
    {
        const std::wstring name = b64ToWide(jsonField(message, "nameB64"));
        const std::string text = base64Decode(jsonField(message, "textB64"));
        replyResult(id, !name.empty() && writeFileBytes(sessionFile(name), text, true));
        return;
    }
    if (method == "export-session")
    {
        const std::string jsonText = base64Decode(jsonField(message, "jsonB64"));
        const std::string txtText = base64Decode(jsonField(message, "txtB64"));
        std::wstring path;
        if (!pickSaveFile(path, kSessionFilter, L"json", L"session.json"))
        {
            replyResult(id, false);
            return;
        }
        const bool asText = path.size() > 4 && _wcsicmp(path.c_str() + path.size() - 4, L".txt") == 0;
        replyResult(id, writeFileBytes(path, asText ? txtText : jsonText, false));
        return;
    }
    replyError(id, "unknown-method");
}

// ---------------------------------------------------------------------------
// WebView2 callbacks
// ---------------------------------------------------------------------------

class MessageHandler final : public aio::ComHandler<ICoreWebView2WebMessageReceivedEventHandler,
                                                    aio::iid::WebMessageReceivedHandler>
{
public:
    HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2 *, ICoreWebView2WebMessageReceivedEventArgs *args) override
    {
        LPWSTR raw = nullptr;
        if (!args || FAILED(args->get_WebMessageAsJson(&raw)) || !raw) return S_OK;
        const std::string message = wideToUtf8(raw);
        CoTaskMemFree(raw);

        const std::string channel = jsonField(message, "channel");
        if (channel == "log")
        {
            const std::string text = base64Decode(jsonField(message, "messageB64"));
            std::fwprintf(stderr, L"[page] %hs\n", text.c_str());
            std::fflush(stderr);
            return S_OK;
        }
        if (channel == "op")
        {
            if (g_config.verbose)
            {
                std::fwprintf(stderr, L"[op] %hs\n", jsonField(message, "op").c_str());
                std::fflush(stderr);
            }
            if (!sendEngine(message)) replyError(jsonIntField(message, "id"), "engine-unavailable");
            return S_OK;
        }
        if (channel == "aio")
        {
            handleAio(message, jsonIntField(message, "id"));
            return S_OK;
        }
        return S_OK;
    }
};

class NavigationHandler final : public aio::ComHandler<ICoreWebView2NavigationStartingEventHandler,
                                                       aio::iid::NavigationStartingHandler>
{
public:
    HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2 *, ICoreWebView2NavigationStartingEventArgs *args) override
    {
        LPWSTR uri = nullptr;
        if (!args || FAILED(args->get_Uri(&uri)) || !uri) return S_OK;
        const std::wstring target(uri);
        CoTaskMemFree(uri);
        const bool allowedDev = !g_config.devUrl.empty() && target.rfind(g_config.devUrl, 0) == 0;
        const bool allowedApp = target.rfind(std::wstring(L"https://") + kVirtualHost + L"/", 0) == 0;
        if (!allowedDev && !allowedApp) args->put_Cancel(TRUE);
        return S_OK;
    }
};

class ScriptHandler final
    : public aio::ComHandler<ICoreWebView2AddScriptToExecuteOnDocumentCreatedCompletedHandler,
                             aio::iid::AddScriptCompletedHandler>
{
public:
    HRESULT STDMETHODCALLTYPE Invoke(HRESULT result, LPCWSTR scriptId) override
    {
        std::fwprintf(stderr, L"[host] bridge injected (hr=0x%08lX id=%ls)\n",
                      static_cast<unsigned long>(result), scriptId ? scriptId : L"(null)");
        std::fflush(stderr);
        return S_OK;
    }
};

/**
 * Asks the page for its latest session as base64 and writes it. Used by the
 * periodic autosave timer and by WM_CLOSE (close=true). This closes the race
 * where the debounced write-session message is still in flight when the
 * WebView is torn down.
 */
class SessionSaveHandler final
    : public aio::ComHandler<ICoreWebView2ExecuteScriptCompletedHandler,
                             aio::iid::ExecuteScriptCompletedHandler>
{
public:
    explicit SessionSaveHandler(bool close) : close_(close) {}

    HRESULT STDMETHODCALLTYPE Invoke(HRESULT result, LPCWSTR json) override
    {
        if (SUCCEEDED(result) && json)
        {
            std::wstring text(json);
            if (text.size() >= 2 && text.front() == L'"' && text.back() == L'"')
                text = text.substr(1, text.size() - 2);
            if (!text.empty() && text != L"null")
            {
                const std::string decoded = base64Decode(wideToUtf8(text));
                // Only replace the session when the page returned real session JSON.
                if (decoded.size() > 2 && decoded.front() == '{' && decoded.find("\"seed\"") != std::string::npos)
                    writeFileBytes(sessionFile(L"map"), decoded, true);
            }
        }
        if (close_ && g_hwnd) DestroyWindow(g_hwnd);
        return S_OK;
    }

private:
    bool close_ = false;
};

void saveSession(bool close)
{
    if (!g_webview)
    {
        if (close && g_hwnd) DestroyWindow(g_hwnd);
        return;
    }
    if (close) g_closeSavePending = true;
    const HRESULT requested = g_webview->ExecuteScript(
        L"window.__AIO_SESSION_B64__ ? window.__AIO_SESSION_B64__() : null",
        new SessionSaveHandler(close));
    if (FAILED(requested) && close)
    {
        g_closeSavePending = false;
        if (g_hwnd) DestroyWindow(g_hwnd);
    }
}

bool retryWithTempProfile(); /* defined after EnvHandler */

class ControllerHandler final : public aio::ComHandler<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler,
                                                       aio::iid::CreateControllerCompletedHandler>
{
public:
    HRESULT STDMETHODCALLTYPE Invoke(HRESULT result, ICoreWebView2Controller *controller) override
    {
        if (FAILED(result) || !controller)
        {
            std::fwprintf(stderr, L"[host] CreateCoreWebView2Controller failed (0x%08lX)\n",
                          static_cast<unsigned long>(result));
            if (!g_tempProfileTried && retryWithTempProfile())
                return S_OK;
            wchar_t message[1200] = {};
            _snwprintf_s(message, _countof(message), _TRUNCATE,
                         L"Failed to create the WebView2 controller (0x%08lX).\n\n"
                         L"Close other copies of this app, or move it out of a synced/network folder.\n"
                         L"Install or repair Microsoft Edge WebView2 Runtime if that does not help:\n"
                         L"https://go.microsoft.com/fwlink/p/?LinkId=2124703\n\n"
                         L"User data folder:\n%ls",
                         static_cast<unsigned long>(result), g_userDataDir.c_str());
            MessageBoxW(nullptr, message, kWindowTitle, MB_ICONERROR);
            g_exitCode = 3;
            DestroyWindow(g_hwnd);
            return S_OK;
        }
        g_controller.attach(controller);
        RECT bounds = {};
        GetClientRect(g_hwnd, &bounds);
        g_controller->put_Bounds(bounds);
        g_controller->put_IsVisible(TRUE);

        if (FAILED(g_controller->get_CoreWebView2(g_webview.put())) || !g_webview)
        {
            g_exitCode = 3;
            DestroyWindow(g_hwnd);
            return S_OK;
        }

        std::fwprintf(stderr, L"[host] webview ready\n");
        std::fflush(stderr);
        aio::ComPtr<ICoreWebView2Settings> settings;
        if (SUCCEEDED(g_webview->get_Settings(settings.put())) && settings)
        {
            settings->put_AreDevToolsEnabled(g_config.devUrl.empty() ? FALSE : TRUE);
            settings->put_AreDefaultContextMenusEnabled(g_config.devUrl.empty() ? FALSE : TRUE);
            settings->put_IsStatusBarEnabled(FALSE);
            settings->put_IsZoomControlEnabled(FALSE);
        }

        aio::ComPtr<ICoreWebView2_3> webview3;
        if (FAILED(g_webview->QueryInterface(aio::iid::CoreWebView2_3, webview3.put_void())) || !webview3)
        {
            g_exitCode = 3;
            DestroyWindow(g_hwnd);
            return S_OK;
        }
        const HRESULT mapped = webview3->SetVirtualHostNameToFolderMapping(
            kVirtualHost, g_config.distDir.c_str(), COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_ALLOW);
        if (FAILED(mapped))
        {
            wchar_t message[900] = {};
            _snwprintf_s(message, _countof(message), _TRUNCATE,
                         L"Virtual host mapping failed (0x%08lX).\nFolder: %ls\n\n"
                         L"The folder must exist and be an absolute path.",
                         static_cast<unsigned long>(mapped), g_config.distDir.c_str());
            MessageBoxW(g_hwnd, message, kWindowTitle, MB_ICONERROR);
            g_exitCode = 6;
            DestroyWindow(g_hwnd);
            return S_OK;
        }

        EventRegistrationToken token = {};
        g_webview->add_WebMessageReceived(new MessageHandler(), &token);
        g_webview->add_NavigationStarting(new NavigationHandler(), &token);

        std::string bridge;
        if (!readFileBytes(joinPath(g_config.webDir, L"bridge.js"), bridge))
        {
            std::fwprintf(stderr, L"[host] web/bridge.js missing\n");
            g_exitCode = 3;
            DestroyWindow(g_hwnd);
            return S_OK;
        }

        // System locale + whether a saved map session exists: read synchronously by
        // the page before its first paint (i18n.ts reads window.aio.initialLocale).
        const LANGID language = GetUserDefaultUILanguage();
        const char *locale = (PRIMARYLANGID(language) == LANG_CHINESE) ? "zh" : "en";
        const bool hasSession = GetFileAttributesW(sessionFile(L"map").c_str()) != INVALID_FILE_ATTRIBUTES;
        std::string boot = std::string("window.__AIO_BOOT__ = {\"locale\":\"") + locale +
                           "\",\"hasSession\":" + (hasSession ? "true" : "false") + "};\n";
        boot += bridge;
        const std::wstring bootWide = utf8ToWide(boot);
        // The completion handler is mandatory: passing nullptr makes WebView2 skip
        // the injection entirely, which leaves the page without window.aio.
        g_webview->AddScriptToExecuteOnDocumentCreated(bootWide.c_str(), new ScriptHandler());

        if (g_config.devUrl.empty())
        {
            const std::wstring url = std::wstring(L"https://") + kVirtualHost + L"/index.html";
            g_webview->Navigate(url.c_str());
        }
        else
        {
            g_webview->Navigate(g_config.devUrl.c_str());
        }
        std::fwprintf(stderr, L"[host] webview shown\n");
        std::fflush(stderr);
        return S_OK;
    }
};

class EnvHandler final : public aio::ComHandler<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler,
                                                aio::iid::CreateEnvironmentCompletedHandler>
{
public:
    HRESULT STDMETHODCALLTYPE Invoke(HRESULT result, ICoreWebView2Environment *env) override
    {
        if (FAILED(result) || !env)
        {
            std::fwprintf(stderr, L"[host] environment failed (0x%08lX)\n", static_cast<unsigned long>(result));
            // One retry with a profile under %TEMP% (always local, even when
            // LOCALAPPDATA is redirected or the per-process folder is blocked).
            if (!g_tempProfileTried && retryWithTempProfile())
                return S_OK;
            wchar_t message[1200] = {};
            _snwprintf_s(message, _countof(message), _TRUNCATE,
                         L"Failed to create the WebView2 environment (0x%08lX).\n\n"
                         L"Close other copies of this app, or move it out of a synced/network folder.\n"
                         L"Install or repair Microsoft Edge WebView2 Runtime if that does not help:\n"
                         L"https://go.microsoft.com/fwlink/p/?LinkId=2124703\n\n"
                         L"User data folder:\n%ls",
                         static_cast<unsigned long>(result), g_userDataDir.c_str());
            MessageBoxW(nullptr, message, kWindowTitle, MB_ICONERROR);
            g_exitCode = 4;
            DestroyWindow(g_hwnd);
            return S_OK;
        }
        g_env.attach(env);
        g_env->CreateCoreWebView2Controller(g_hwnd, new ControllerHandler());
        return S_OK;
    }
};

// LOCALAPPDATA can be redirected to a network share on managed machines, which
// WebView2 rejects (often as E_UNEXPECTED); %TEMP% is always local.
bool retryWithTempProfile()
{
    g_tempProfileTried = true;
    wchar_t tempRoot[MAX_PATH] = {};
    if (!GetTempPathW(MAX_PATH, tempRoot))
        return false;
    wchar_t name[96] = {};
    _snwprintf_s(name, _countof(name), _TRUNCATE, L"All-In-One Finder\\t%lu-%llu\\WebView2",
                 GetCurrentProcessId(), static_cast<unsigned long long>(GetTickCount64()));
    g_userDataDir = joinPath(tempRoot, name);
    ensureDir(g_userDataDir);
    std::fwprintf(stderr, L"[host] retry profile in TEMP: %ls\n", g_userDataDir.c_str());
    std::fflush(stderr);
    return SUCCEEDED(g_createEnv(nullptr, g_userDataDir.c_str(), nullptr, new EnvHandler()));
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

LRESULT CALLBACK wndProc(HWND hwnd, UINT message, WPARAM wParam, LPARAM lParam)
{
    switch (message)
    {
    case WM_DPICHANGED:
    {
        const RECT *suggested = reinterpret_cast<const RECT *>(lParam);
        SetWindowPos(hwnd, nullptr, suggested->left, suggested->top, suggested->right - suggested->left,
                     suggested->bottom - suggested->top, SWP_NOZORDER | SWP_NOACTIVATE);
        return 0;
    }
    case WM_SIZE:
        if (g_controller)
        {
            RECT bounds = {};
            GetClientRect(hwnd, &bounds);
            g_controller->put_Bounds(bounds);
        }
        return 0;
    case WM_TIMER:
        if (wParam == kSmokeTimer)
        {
            KillTimer(hwnd, kSmokeTimer);
            std::fwprintf(stderr, L"[host] smoke timeout\n");
            g_exitCode = 1;
            DestroyWindow(hwnd);
        }
        else if (wParam == kSessionTimer)
        {
            saveSession(false);
        }
        return 0;
    case WM_COMMAND:
        switch (LOWORD(wParam))
        {
        case ID_IMPORT:
        {
            std::wstring path;
            std::string text;
            if (pickOpenFile(path, kSessionFilter) && readFileBytes(path, text))
                postEvent("session-import", base64Encode(text));
            break;
        }
        case ID_EXPORT: postEvent("session-export"); break;
        case ID_ABOUT: postEvent("show-about"); break;
        case ID_EXIT: PostMessageW(hwnd, WM_CLOSE, 0, 0); break;
        default: break;
        }
        return 0;
    case WM_APP_ENGINE:
    {
        auto *payload = reinterpret_cast<std::string *>(lParam);
        if (payload)
        {
            if (g_config.smoke && !g_smokeDone && payload->find("\"ok\":true") != std::string::npos)
            {
                g_smokeDone = true;
                g_exitCode = 0;
                std::fwprintf(stdout, L"[smoke] engine round-trip OK\n");
                std::fflush(stdout);
                PostMessageW(hwnd, WM_CLOSE, 0, 0);
            }
            if (g_config.verbose) { std::fwprintf(stderr, L"[resp] %.80hs\n", payload->c_str()); std::fflush(stderr); }
            postRaw(*payload);
            delete payload;
        }
        return 0;
    }
    case WM_CLOSE:
        std::fwprintf(stderr, L"[host] WM_CLOSE\n");
        std::fflush(stderr);
        if (!g_closeSavePending)
        {
            saveSession(true);
            return 0;
        }
        DestroyWindow(hwnd);
        return 0;
    case WM_DESTROY:
        std::fwprintf(stderr, L"[host] WM_DESTROY exit=%d\n", g_exitCode);
        std::fflush(stderr);
        PostQuitMessage(g_exitCode);
        return 0;
    default:
        return DefWindowProcW(hwnd, message, wParam, lParam);
    }
}

void installMenu()
{
    HMENU menu = CreateMenu();
    HMENU file = CreatePopupMenu();
    AppendMenuW(file, MF_STRING, ID_IMPORT, L"&Import Session...\tCtrl+O");
    AppendMenuW(file, MF_STRING, ID_EXPORT, L"&Export Session...\tCtrl+S");
    AppendMenuW(file, MF_SEPARATOR, 0, nullptr);
    AppendMenuW(file, MF_STRING, ID_EXIT, L"E&xit");
    AppendMenuW(menu, MF_POPUP, reinterpret_cast<UINT_PTR>(file), L"&File");

    HMENU help = CreatePopupMenu();
    AppendMenuW(help, MF_STRING, ID_ABOUT, L"&About");
    AppendMenuW(menu, MF_POPUP, reinterpret_cast<UINT_PTR>(help), L"&Help");
    SetMenu(g_hwnd, menu);
}

std::wstring localAppDataDir()
{
    wchar_t *value = nullptr;
    size_t length = 0;
    std::wstring base;
    if (_wdupenv_s(&value, &length, L"LOCALAPPDATA") == 0 && value)
    {
        base = value;
        free(value);
    }
    if (base.empty())
    {
        // Environment can be sanitized by a launcher; ask Windows directly.
        wchar_t fallback[MAX_PATH] = {};
        if (SUCCEEDED(SHGetFolderPathW(nullptr, CSIDL_LOCAL_APPDATA | CSIDL_FLAG_CREATE, nullptr,
                                       SHGFP_TYPE_CURRENT, fallback)))
            base = fallback;
    }
    return base.empty() ? L"." : joinPath(base, L"All-In-One Finder");
}

std::wstring envPath(const wchar_t *name)
{
    wchar_t *value = nullptr;
    size_t length = 0;
    std::wstring out;
    if (_wdupenv_s(&value, &length, name) == 0 && value)
    {
        out = value;
        free(value);
    }
    return out;
}

/**
 * Pick a writable, persistent app-data base. LocalAppData is tried first, then
 * Roaming AppData, the portable exe's own folder, Documents and finally TEMP.
 * An existing session always wins, so a fallback used once keeps being reused.
 *
 * AIO_SESSION_BASE can force a base directory for unusual environments.
 */
std::wstring appDataBaseDir(const std::wstring &portableDir)
{
    std::vector<std::wstring> candidates;
    if (const auto overrideDir = envPath(L"AIO_SESSION_BASE"); !overrideDir.empty())
        candidates.push_back(overrideDir);
    candidates.push_back(localAppDataDir());
    if (const auto roaming = envPath(L"APPDATA"); !roaming.empty())
        candidates.push_back(joinPath(roaming, L"All-In-One Finder"));
    if (!portableDir.empty())
        candidates.push_back(joinPath(portableDir, L"All-In-One Finder Data"));
    wchar_t documents[MAX_PATH] = {};
    if (SUCCEEDED(SHGetFolderPathW(nullptr, CSIDL_PERSONAL, nullptr, SHGFP_TYPE_CURRENT, documents)))
        candidates.push_back(joinPath(documents, L"All-In-One Finder"));
    wchar_t temp[MAX_PATH] = {};
    if (GetTempPathW(MAX_PATH, temp))
        candidates.push_back(joinPath(temp, L"All-In-One Finder"));

    const auto hasSession = [](const std::wstring &base) {
        return GetFileAttributesW(joinPath(joinPath(base, L"session"), L"map.json").c_str()) !=
               INVALID_FILE_ATTRIBUTES;
    };
    for (const auto &candidate : candidates)
        if (hasSession(candidate) && writableDir(joinPath(candidate, L"session")))
            return candidate;
    for (const auto &candidate : candidates)
        if (writableDir(joinPath(candidate, L"session")))
            return candidate;
    return localAppDataDir();
}

bool parseArgs(Config &config)
{
    int argc = 0;
    LPWSTR *argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    for (int i = 1; argv && i < argc; ++i)
    {
        const std::wstring arg = argv[i];
        auto next = [&](std::wstring &target) {
            if (i + 1 < argc) target = argv[++i];
        };
        if (arg == L"--portable-dir") next(config.portableDir);
        else if (arg == L"--dist") next(config.distDir);
        else if (arg == L"--web") next(config.webDir);
        else if (arg == L"--dev") next(config.devUrl);
        else if (arg == L"--smoke") config.smoke = true;
        else if (arg == L"--engine") config.engine = true;
        else if (arg == L"--verbose") config.verbose = true;
    }
    if (argv) LocalFree(argv);
    return true;
}

} // namespace

int WINAPI WinMain(HINSTANCE, HINSTANCE, LPSTR, int)
{
    Config config;
    parseArgs(config);
    config.exeDir = exeDir();
    if (config.portableDir.empty()) config.portableDir = config.exeDir;
    if (config.distDir.empty()) config.distDir = joinPath(config.exeDir, L"dist");
    if (config.webDir.empty()) config.webDir = joinPath(config.exeDir, L"web");
    config.hostExe = exePath();
    config.dllPath = joinPath(config.exeDir, L"allinone.dll");
    // WebView2 requires an absolute folder for the virtual host mapping, and the
    // engine needs absolute paths when spawned with a different working directory.
    config.portableDir = absolutePath(config.portableDir);
    config.distDir = absolutePath(config.distDir);
    config.webDir = absolutePath(config.webDir);
    g_config = config;

    // Child mode: serve the engine on stdin/stdout (spawned by startEngine()).
    if (config.engine)
    {
        return aio::loadEngine(config.dllPath) ? aio::runServer() : 3;
    }

    if (GetFileAttributesW(joinPath(config.distDir, L"index.html").c_str()) == INVALID_FILE_ATTRIBUTES)
    {
        MessageBoxW(nullptr, L"dist/index.html not found next to the executable.", kWindowTitle, MB_ICONERROR);
        return 2;
    }

    // Session data lives under a writable per-user base. LocalAppData is preferred,
    // but locked-down environments may block it; appDataBaseDir() falls back to
    // Roaming AppData / Documents so the session still survives restarts.
    const std::wstring userBase = appDataBaseDir(config.portableDir);
    ensureDir(userBase);
    const std::wstring sessionRoot = joinPath(userBase, L"session");
    const bool sessionDirOk = ensureDir(sessionRoot);
    const DWORD sessionError = sessionDirOk ? 0 : GetLastError();
    g_sessionDir = sessionRoot;
    {
        const std::string startup = "version=" AIO_VERSION_STRING "\r\nexe=" + wideToUtf8(exePath()) +
                                    "\r\nbase=" + wideToUtf8(userBase) +
                                    "\r\nsession=" + wideToUtf8(sessionRoot) +
                                    "\r\nsession-dir-ok=" + (sessionDirOk ? "1" : "0") +
                                    "\r\nsession-error=" + std::to_string(static_cast<unsigned long>(sessionError)) +
                                    "\r\n";
        writeFileBytes(joinPath(userBase, L"host-startup.log"), startup, true);
    }
    if (!sessionDirOk)
    {
        const std::wstring message = L"无法创建 session 目录，session 将无法保存：\n" + sessionRoot +
                                     L"\n\n错误码：" + std::to_wstring(static_cast<unsigned long>(sessionError)) +
                                     L"\n\n可设置环境变量 AIO_SESSION_BASE 指向一个可写目录后重试。";
        MessageBoxW(nullptr, message.c_str(), kWindowTitle, MB_ICONERROR);
    }

    // Older portable builds kept the session next to the exe; adopt it once.
    const std::wstring legacySession = joinPath(config.portableDir, L"session\\map.json");
    const std::wstring currentSession = joinPath(sessionRoot, L"map.json");
    if (GetFileAttributesW(currentSession.c_str()) == INVALID_FILE_ATTRIBUTES
        && GetFileAttributesW(legacySession.c_str()) != INVALID_FILE_ATTRIBUTES)
    {
        CopyFileW(legacySession.c_str(), currentSession.c_str(), FALSE);
        std::fwprintf(stderr, L"[host] migrated session from %ls\n", legacySession.c_str());
    }

    // A per-process WebView2 profile avoids ERROR_BUSY from a previous instance,
    // a sync client or an indexer holding the same profile folder.
    wchar_t profileName[64] = {};
    _snwprintf_s(profileName, _countof(profileName), _TRUNCATE, L"profiles\\p%lu-%llu",
                 GetCurrentProcessId(), static_cast<unsigned long long>(GetTickCount64()));
    g_userDataDir = joinPath(userBase, std::wstring(profileName) + L"\\WebView2");
    ensureDir(g_userDataDir);
    {
        // Keep the per-process WebView2 profiles from growing forever.
        std::error_code ec;
        const std::filesystem::path root = std::filesystem::path(userBase) / L"profiles";
        if (std::filesystem::exists(root, ec))
        {
            const auto now = std::filesystem::file_time_type::clock::now();
            for (const auto &entry : std::filesystem::directory_iterator(root, ec))
            {
                if (ec) break;
                std::error_code timeError;
                const auto stamp = std::filesystem::last_write_time(entry.path(), timeError);
                if (timeError) continue;
                if (now - stamp > std::chrono::hours(72)) std::filesystem::remove_all(entry.path(), ec);
            }
        }
    }
    std::fwprintf(stderr, L"[host] session=%ls userdata=%ls\n", g_sessionDir.c_str(), g_userDataDir.c_str());
    std::fflush(stderr);

    // The engine (trial searcher in particular) keeps checkpoint files under
    // AIO_DATA_DIR; Electron's main process used to provide it. The subprocess
    // inherits this environment block.
    const std::wstring engineDataDir = joinPath(userBase, L"userdata");
    ensureDir(engineDataDir);
    SetEnvironmentVariableW(L"AIO_DATA_DIR", engineDataDir.c_str());

    // Single instance per portable directory. The NSIS launcher extracts to a new
    // temp folder on every run, so keying on the exe directory would let two
    // launchers run at once and share (and fight over) the same WebView2 profile.
    std::wstring mutexName = L"Local\\AIOF_" + std::to_wstring(std::hash<std::wstring>{}(config.portableDir));
    HANDLE mutex = CreateMutexW(nullptr, TRUE, mutexName.c_str());
    if (mutex && GetLastError() == ERROR_ALREADY_EXISTS)
    {
        HWND existing = FindWindowW(kWindowClass, nullptr);
        if (existing)
        {
            ShowWindow(existing, SW_RESTORE);
            SetForegroundWindow(existing);
        }
        return 0;
    }

    SetCurrentProcessExplicitAppUserModelID(L"SunnySlopes.AllInOneFinder");
    const HRESULT comInit = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    if (FAILED(comInit))
    {
        MessageBoxW(nullptr, L"COM initialization failed.", kWindowTitle, MB_ICONERROR);
        return 2;
    }

    if (!loadWebView2Loader())
    {
        MessageBoxW(nullptr, L"WebView2 Runtime is missing or too old.\nInstall the Evergreen WebView2 Runtime and retry.",
                    kWindowTitle, MB_ICONERROR);
        return 3;
    }

    if (!startEngine())
    {
        MessageBoxW(nullptr, L"Failed to start aio-engine.exe.\nCheck that aio-engine.exe and allinone.dll are next to this executable.",
                    kWindowTitle, MB_ICONERROR);
        return 3;
    }

    WNDCLASSEXW windowClass = {};
    windowClass.cbSize = sizeof(windowClass);
    windowClass.lpfnWndProc = wndProc;
    windowClass.hInstance = GetModuleHandleW(nullptr);
    windowClass.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    windowClass.hbrBackground = CreateSolidBrush(RGB(0x12, 0x14, 0x18));
    windowClass.lpszClassName = kWindowClass;
    // Taskbar / Alt-Tab / pinned shortcuts take the icon from the window class;
    // without it Windows falls back to the generic application icon.
    windowClass.hIcon = LoadIconW(windowClass.hInstance, MAKEINTRESOURCEW(1));
    windowClass.hIconSm = static_cast<HICON>(LoadImageW(
        windowClass.hInstance, MAKEINTRESOURCEW(1), IMAGE_ICON,
        GetSystemMetrics(SM_CXSMICON), GetSystemMetrics(SM_CYSMICON), LR_DEFAULTCOLOR));
    RegisterClassExW(&windowClass);

    // Center on the work area and clamp to it. Sizes below are DIPs, so scale by
    // the monitor DPI: a PerMonitorV2 window takes physical pixels.
    RECT work = {};
    SystemParametersInfoW(SPI_GETWORKAREA, 0, &work, 0);
    const UINT dpi = GetDpiForSystem();
    const int workWidth = work.right - work.left;
    const int workHeight = work.bottom - work.top;
    const int wantedWidth = MulDiv(1500, static_cast<int>(dpi), 96);
    const int wantedHeight = MulDiv(1000, static_cast<int>(dpi), 96);
    const int width = workWidth < wantedWidth + 48 ? workWidth - 24 : wantedWidth;
    const int height = workHeight < wantedHeight + 48 ? workHeight - 24 : wantedHeight;
    const int posX = work.left + (workWidth - width) / 2;
    const int posY = work.top + (workHeight - height) / 2;
    std::fwprintf(stderr, L"[host] window %dx%d at %d,%d\n", width, height, posX, posY);
    std::fflush(stderr);
    g_hwnd = CreateWindowExW(0, kWindowClass, kWindowTitle, WS_OVERLAPPEDWINDOW, posX, posY, width, height,
                             nullptr, nullptr, windowClass.hInstance, nullptr);
    if (!g_hwnd)
    {
        stopEngine();
        CoUninitialize();
        return 2;
    }
    if (windowClass.hIcon) SendMessageW(g_hwnd, WM_SETICON, ICON_BIG, reinterpret_cast<LPARAM>(windowClass.hIcon));
    if (windowClass.hIconSm) SendMessageW(g_hwnd, WM_SETICON, ICON_SMALL, reinterpret_cast<LPARAM>(windowClass.hIconSm));
    installMenu();
    ShowWindow(g_hwnd, SW_SHOWNORMAL);
    UpdateWindow(g_hwnd);
    SetTimer(g_hwnd, kSessionTimer, kSessionIntervalMs, nullptr);
    if (config.smoke) SetTimer(g_hwnd, kSmokeTimer, kSmokeTimeoutMs, nullptr);

    if (FAILED(g_createEnv(nullptr, g_userDataDir.c_str(), nullptr, new EnvHandler())))
    {
        MessageBoxW(nullptr,
                    L"Failed to create the WebView2 environment.\n\n"
                    L"Install or repair Microsoft Edge WebView2 Runtime, then retry:\n"
                    L"https://go.microsoft.com/fwlink/p/?LinkId=2124703",
                    kWindowTitle, MB_ICONERROR);
        g_exitCode = 3;
        DestroyWindow(g_hwnd);
    }

    MSG msg = {};
    while (GetMessageW(&msg, nullptr, 0, 0) > 0)
    {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }

    if (g_controller) g_controller->Close();
    g_webview.reset();
    g_controller.reset();
    g_env.reset();
    stopEngine();
    if (mutex)
    {
        ReleaseMutex(mutex);
        CloseHandle(mutex);
    }
    CoUninitialize();
    return g_exitCode;
}













