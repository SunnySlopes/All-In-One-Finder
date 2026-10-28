// M0 feasibility spike: does MinGW/UCRT64 g++ parse the WebView2 SDK headers and
// can we implement its COM callbacks without WRL? Not shipped; validates G1.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <objbase.h>

#include <WebView2.h>
// NOTE: WebView2EnvironmentOptions.h pulls in <wrl/implements.h> (MSVC-only) and is
// deliberately NOT used under MinGW; pass nullptr options instead.

#include <atomic>

class EnvHandler : public ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler
{
public:
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void **ppv) override
    {
        if (!ppv) return E_POINTER;
        if (riid == IID_IUnknown || riid == IID_ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler)
        {
            *ppv = static_cast<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler *>(this);
            AddRef();
            return S_OK;
        }
        *ppv = nullptr;
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return ++refs; }
    ULONG STDMETHODCALLTYPE Release() override
    {
        const ULONG left = --refs;
        if (!left) delete this;
        return left;
    }
    HRESULT STDMETHODCALLTYPE Invoke(HRESULT result, ICoreWebView2Environment *env) override
    {
        if (SUCCEEDED(result) && env) env->CreateCoreWebView2Controller(nullptr, nullptr);
        return S_OK;
    }

private:
    std::atomic<ULONG> refs{1};
};

int main()
{
    ICoreWebView2Environment *env = nullptr;
    ICoreWebView2Controller *controller = nullptr;
    ICoreWebView2 *webview = nullptr;
    ICoreWebView2Settings *settings = nullptr;

    if (env) env->CreateCoreWebView2Controller(nullptr, nullptr);
    if (controller) controller->get_CoreWebView2(&webview);
    if (webview)
    {
        LPWSTR source = nullptr;
        webview->get_Source(&source);
        webview->Navigate(L"https://app.local/");
        webview->PostWebMessageAsJson(L"{\"ok\":true}");
        if (source) CoTaskMemFree(source);
    }
    if (settings) settings->put_AreDevToolsEnabled(FALSE);

    // Loader entry point: resolved dynamically at runtime (no import library needed).
    HMODULE loader = LoadLibraryW(L"WebView2Loader.dll");
    using CreateFn = HRESULT (STDMETHODCALLTYPE *)(PCWSTR, PCWSTR, ICoreWebView2EnvironmentOptions *,
                                                    ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler *);
    CreateFn create = loader
        ? reinterpret_cast<CreateFn>(GetProcAddress(loader, "CreateCoreWebView2EnvironmentWithOptions"))
        : nullptr;
    if (create)
    {
        auto *handler = new EnvHandler();
        create(nullptr, nullptr, nullptr, handler);
        handler->Release();
    }
    return 0;
}
