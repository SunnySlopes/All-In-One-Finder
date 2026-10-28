// Minimal COM helpers for the WebView2 host (no WRL: WRL is MSVC-only).
#pragma once

#include <windows.h>

#include <atomic>

#include "webview_iids.h"

namespace aio {

template <class T>
class ComPtr
{
public:
    ComPtr() = default;
    ~ComPtr() { reset(); }

    ComPtr(const ComPtr &) = delete;
    ComPtr &operator=(const ComPtr &) = delete;

    ComPtr(ComPtr &&other) noexcept : ptr_(other.ptr_) { other.ptr_ = nullptr; }
    ComPtr &operator=(ComPtr &&other) noexcept
    {
        if (this != &other)
        {
            reset();
            ptr_ = other.ptr_;
            other.ptr_ = nullptr;
        }
        return *this;
    }

    T *get() const { return ptr_; }
    T *operator->() const { return ptr_; }
    explicit operator bool() const { return ptr_ != nullptr; }

    T **put()
    {
        reset();
        return &ptr_;
    }

    void **put_void()
    {
        reset();
        return reinterpret_cast<void **>(&ptr_);
    }

    void reset()
    {
        if (ptr_)
        {
            ptr_->Release();
            ptr_ = nullptr;
        }
    }

    // Takes a reference (like ComPtr::Attach with an implicit AddRef).
    void attach(T *p)
    {
        reset();
        ptr_ = p;
        if (ptr_) ptr_->AddRef();
    }

private:
    T *ptr_ = nullptr;
};

// Reference-counted implementation of a WebView2 callback interface.
// WebView2 only ever queries IUnknown and the concrete handler interface.
template <class T, const GUID &Iid>
class ComHandler : public T
{
public:
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void **ppv) override
    {
        if (!ppv) return E_POINTER;
        if (IsEqualGUID(riid, iid::IUnknown) || IsEqualGUID(riid, Iid))
        {
            *ppv = static_cast<T *>(this);
            AddRef();
            return S_OK;
        }
        *ppv = nullptr;
        return E_NOINTERFACE;
    }

    ULONG STDMETHODCALLTYPE AddRef() override { return ++refs_; }

    ULONG STDMETHODCALLTYPE Release() override
    {
        const ULONG left = --refs_;
        if (left == 0) delete this;
        return left;
    }

protected:
    ~ComHandler() = default;

private:
    std::atomic<ULONG> refs_{1};
};

} // namespace aio
